import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sha256File } from '../hash.js';
import type { CallInfo, ParseResult, SymbolInfo, SymbolKind } from '../../analyzers/base-analyzer.js';
import { parseFilesBatch, type ParseBatchOptions, type ParseWorkItem, type ParseWorkResult } from './parse.js';

/**
 * Version of path-/content-derived indexing logic that is NOT owned by a parse
 * provider — file-role classification, role-derived filtering, and any other
 * derivation written onto file rows. It is folded into the provider-set version
 * so a change here invalidates cached snapshots and forces a full re-derive on
 * the next index, instead of incremental refresh silently serving stale values
 * (e.g. a file-role fix that never reaches unchanged files). Bump on any change
 * to that derivation logic.
 */
export const DERIVATION_LOGIC_VERSION = 3;

export interface IndexProviderOptions {
  root: string;
  indexProviders?: string[] | string;
  scipIndexPath?: string;
}

export interface IndexProvider {
  id: string;
  version: string;
  parseFiles(workItems: ParseWorkItem[], options: ParseBatchOptions): ParseWorkResult[];
}

export interface IndexProviderSet {
  id: string;
  version: string;
  providerIds: string[];
  providerVersions: Record<string, string>;
  config: {
    indexProviders: string[];
    scipIndexPath?: string;
  };
  parseFiles(workItems: ParseWorkItem[], options: ParseBatchOptions): ParseWorkResult[];
}

interface ScipIndex {
  metadata?: Record<string, unknown>;
  documents?: ScipDocument[];
  externalSymbols?: ScipSymbolInformation[];
  external_symbols?: ScipSymbolInformation[];
}

interface ScipDocument {
  language?: string;
  relativePath?: string;
  relative_path?: string;
  occurrences?: ScipOccurrence[];
  symbols?: ScipSymbolInformation[];
}

interface ScipOccurrence {
  range?: number[];
  symbol?: string;
  symbolRoles?: number | string;
  symbol_roles?: number | string;
  enclosingRange?: number[];
  enclosing_range?: number[];
}

interface ScipSymbolInformation {
  symbol?: string;
  displayName?: string;
  display_name?: string;
  kind?: string | number;
  signatureDocumentation?: {
    language?: string;
    text?: string;
  };
  signature_documentation?: {
    language?: string;
    text?: string;
  };
  documentation?: string[];
  relationships?: Array<{
    symbol?: string;
    isImplementation?: boolean;
    is_implementation?: boolean;
    isTypeDefinition?: boolean;
    is_type_definition?: boolean;
  }>;
  enclosingSymbol?: string;
  enclosing_symbol?: string;
}

const TREE_SITTER_PROVIDER_ID = 'tree-sitter';
const TREE_SITTER_PROVIDER_VERSION = 'tree-sitter-analyzer-v24-default-field-usages';
const TREE_SITTER_FIELD_USAGE_DISABLED_PROVIDER_VERSION = 'tree-sitter-analyzer-v24-field-usages-disabled';
const SCIP_PROVIDER_ID = 'scip';
const SYMBOL_ROLE_DEFINITION = 0x1;
const SYMBOL_ROLE_IMPORT = 0x2;

export function buildIndexProviderSet(options: IndexProviderOptions): IndexProviderSet {
  const providerNames = normalizeProviderNames(options.indexProviders ?? process.env.CODEGRAPH_INDEX_PROVIDERS);
  const providers = providerNames.map(name => {
    switch (name) {
      case TREE_SITTER_PROVIDER_ID:
        return new TreeSitterIndexProvider();
      case SCIP_PROVIDER_ID:
        return new ScipIndexProvider(resolveScipIndexPath(options.root, options.scipIndexPath));
      default:
        throw new Error(`Unsupported index provider "${name}". Supported providers: tree-sitter, scip.`);
    }
  });
  const providerIds = providers.map(provider => provider.id);
  // The `__derivation` synthetic entry folds non-provider derivation logic
  // (file-role classification etc.) into providerVersions, which is the value
  // `snapshotProviderMatches` compares and the parse-cache key uses. Bumping
  // DERIVATION_LOGIC_VERSION therefore invalidates stale snapshots + parse
  // caches and forces a full re-derive — closing the gap where incremental
  // refresh kept stale path-derived metadata on unchanged files.
  const providerVersions = {
    ...Object.fromEntries(providers.map(provider => [provider.id, provider.version])),
    __derivation: String(DERIVATION_LOGIC_VERSION),
  };
  return {
    id: providerIds.join('+'),
    version: JSON.stringify(providerVersions),
    providerIds,
    providerVersions,
    config: {
      indexProviders: providerIds,
      scipIndexPath: providers.some(provider => provider.id === SCIP_PROVIDER_ID)
        ? resolveScipIndexPath(options.root, options.scipIndexPath)
        : undefined,
    },
    parseFiles(workItems, batchOptions) {
      if (workItems.length === 0) return [];
      const merged = new Map<string, ParseResult>();
      for (const provider of providers) {
        const results = provider.parseFiles(workItems, provider.id === TREE_SITTER_PROVIDER_ID ? batchOptions : {});
        for (const item of results) {
          const existing = merged.get(item.key);
          merged.set(item.key, existing ? mergeParseResults(existing, item.result) : item.result);
        }
      }
      return workItems
        .map(item => {
          const result = merged.get(item.key);
          return result ? { key: item.key, result } : undefined;
        })
        .filter((item): item is ParseWorkResult => Boolean(item));
    },
  };
}

export function normalizeProviderNames(value: string[] | string | undefined): string[] {
  const names = Array.isArray(value)
    ? value
    : String(value ?? TREE_SITTER_PROVIDER_ID).split(',');
  const normalized = names
    .map(name => name.trim().toLowerCase())
    .filter(Boolean);
  return normalized.length > 0 ? [...new Set(normalized)] : [TREE_SITTER_PROVIDER_ID];
}

class TreeSitterIndexProvider implements IndexProvider {
  readonly id = TREE_SITTER_PROVIDER_ID;
  readonly version = treeSitterFieldUsagesEnabled()
    ? TREE_SITTER_PROVIDER_VERSION
    : TREE_SITTER_FIELD_USAGE_DISABLED_PROVIDER_VERSION;

  parseFiles(workItems: ParseWorkItem[], options: ParseBatchOptions): ParseWorkResult[] {
    return parseFilesBatch(workItems, options);
  }
}

class ScipIndexProvider implements IndexProvider {
  readonly id = SCIP_PROVIDER_ID;
  readonly version: string;
  private readonly resultsByPath: Map<string, ParseResult>;

  constructor(indexPath: string) {
    const absolute = path.resolve(indexPath);
    this.version = `scip-json:${sha256File(absolute)}`;
    this.resultsByPath = scipResultsByPath(loadScipIndex(absolute));
  }

  parseFiles(workItems: ParseWorkItem[]): ParseWorkResult[] {
    const results: ParseWorkResult[] = [];
    for (const item of workItems) {
      const result = this.resultsByPath.get(item.key);
      if (result) results.push({ key: item.key, result });
    }
    return results;
  }
}

function resolveScipIndexPath(root: string, requested: string | undefined): string {
  const raw = requested ?? process.env.CODEGRAPH_SCIP_INDEX;
  if (!raw) throw new Error('The scip provider requires --scip-index or CODEGRAPH_SCIP_INDEX.');
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  if (!fs.existsSync(resolved)) throw new Error(`SCIP index not found: ${resolved}`);
  return resolved;
}

function loadScipIndex(indexPath: string): ScipIndex {
  const content = fs.readFileSync(indexPath);
  const text = content.toString('utf-8').trimStart();
  if (text.startsWith('{')) return JSON.parse(text) as ScipIndex;

  try {
    const json = execFileSync('scip', ['print', '--json', indexPath], {
      encoding: 'utf-8',
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    });
    return JSON.parse(json) as ScipIndex;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read SCIP index as JSON. Provide scip print --json output, or install scip CLI for .scip input. ${reason}`);
  }
}

function scipResultsByPath(index: ScipIndex): Map<string, ParseResult> {
  const results = new Map<string, ParseResult>();
  const externalSymbolsById = new Map<string, ScipSymbolInformation>();
  for (const symbolInfo of [...(index.externalSymbols ?? []), ...(index.external_symbols ?? [])]) {
    if (symbolInfo.symbol) externalSymbolsById.set(symbolInfo.symbol, symbolInfo);
  }
  for (const doc of index.documents ?? []) {
    const file = normalizeScipPath(doc.relativePath ?? doc.relative_path);
    if (!file) continue;
    results.set(file, scipDocumentToParseResult(file, doc, externalSymbolsById));
  }
  return results;
}

function scipDocumentToParseResult(
  file: string,
  doc: ScipDocument,
  externalSymbolsById: Map<string, ScipSymbolInformation>,
): ParseResult {
  const localSymbolsById = new Map<string, ScipSymbolInformation>();
  for (const symbolInfo of doc.symbols ?? []) {
    if (symbolInfo.symbol) localSymbolsById.set(symbolInfo.symbol, symbolInfo);
  }
  const symbolsById = new Map([...externalSymbolsById, ...localSymbolsById]);
  const definitionOccurrences = (doc.occurrences ?? [])
    .filter(occurrence => occurrence.symbol && hasScipRole(occurrence, SYMBOL_ROLE_DEFINITION));
  const definitionBySymbol = new Map<string, ScipOccurrence>();
  for (const occurrence of definitionOccurrences) {
    if (occurrence.symbol && !definitionBySymbol.has(occurrence.symbol)) {
      definitionBySymbol.set(occurrence.symbol, occurrence);
    }
  }
  const ownerBySymbol = parentSymbolsForDefinitions(definitionOccurrences, symbolsById);
  const symbols = [...localSymbolsById.values()]
    .map(symbolInfo => scipSymbolToSymbolInfo(file, symbolInfo, definitionBySymbol.get(symbolInfo.symbol ?? ''), ownerBySymbol))
    .filter((symbol): symbol is SymbolInfo => Boolean(symbol));
  const calls = scipCallsForDocument(file, doc.occurrences ?? [], symbolsById, definitionOccurrences);
  const imports = (doc.occurrences ?? [])
    .filter(occurrence => occurrence.symbol && hasScipRole(occurrence, SYMBOL_ROLE_IMPORT))
    .map(occurrence => ({
      source: displayNameForScipSymbol(occurrence.symbol ?? '', symbolsById),
      symbols: [displayNameForScipSymbol(occurrence.symbol ?? '', symbolsById)],
      file,
      line: scipStartLine(occurrence),
      isExternal: !symbolsById.has(occurrence.symbol ?? ''),
    }));

  return {
    file,
    symbols,
    imports,
    calls,
    references: [],
    hasParseErrors: false,
    parseConfidence: 0.95,
  };
}

function scipSymbolToSymbolInfo(
  file: string,
  symbolInfo: ScipSymbolInformation,
  occurrence: ScipOccurrence | undefined,
  ownerBySymbol: Map<string, string>,
): SymbolInfo | undefined {
  const symbol = symbolInfo.symbol;
  if (!symbol) return undefined;
  const display = displayNameForScipSymbol(symbol, new Map([[symbol, symbolInfo]]));
  const kind = scipKindToSymbolKind(symbolInfo.kind);
  const range = occurrenceRange(occurrence);
  const signature = symbolInfo.signatureDocumentation?.text
    ?? symbolInfo.signature_documentation?.text
    ?? display;
  const parentSymbol = symbolInfo.enclosingSymbol ?? symbolInfo.enclosing_symbol ?? ownerBySymbol.get(symbol);
  return {
    fqName: scipSymbolToFqName(symbol, display, parentSymbol ? displayNameForScipSymbol(parentSymbol, new Map()) : undefined, kind),
    name: display,
    kind,
    file,
    line: range.startLine,
    column: range.startColumn,
    endLine: range.endLine,
    signature,
    visibility: 'public',
    module: path.posix.dirname(file),
    parent: parentSymbol ? displayNameForScipSymbol(parentSymbol, new Map()) : undefined,
    implements: (symbolInfo.relationships ?? [])
      .filter(relationship => relationship.isImplementation === true || relationship.is_implementation === true)
      .map(relationship => displayNameForScipSymbol(relationship.symbol ?? '', new Map()))
      .filter(Boolean),
  };
}

function scipCallsForDocument(
  file: string,
  occurrences: ScipOccurrence[],
  symbolsById: Map<string, ScipSymbolInformation>,
  definitionOccurrences: ScipOccurrence[],
): CallInfo[] {
  const calls: CallInfo[] = [];
  for (const occurrence of occurrences) {
    if (!occurrence.symbol) continue;
    if (hasScipRole(occurrence, SYMBOL_ROLE_DEFINITION) || hasScipRole(occurrence, SYMBOL_ROLE_IMPORT)) continue;
    const callerSymbol = nearestDefinitionSymbol(occurrence, definitionOccurrences);
    const callee = displayNameForScipSymbol(occurrence.symbol, symbolsById);
    calls.push({
      caller: callerSymbol ? displayNameForScipSymbol(callerSymbol, symbolsById) : file,
      callee,
      file,
      line: scipStartLine(occurrence),
      confidence: 0.9,
      resolutionKind: 'scip-reference',
    });
  }
  return calls;
}

function parentSymbolsForDefinitions(
  definitions: ScipOccurrence[],
  symbolsById: Map<string, ScipSymbolInformation>,
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const definition of definitions) {
    if (!definition.symbol) continue;
    const parent = nearestDefinitionSymbol(definition, definitions.filter(candidate => candidate.symbol !== definition.symbol));
    if (parent && isContainerKind(symbolsById.get(parent)?.kind)) owners.set(definition.symbol, parent);
  }
  return owners;
}

function nearestDefinitionSymbol(occurrence: ScipOccurrence, definitions: ScipOccurrence[]): string | undefined {
  const range = occurrence.range;
  if (!range || range.length < 3) return undefined;
  const startLine = range[0] ?? 0;
  const startChar = range[1] ?? 0;
  return definitions
    .filter(candidate => candidate.symbol && containsOccurrenceRange(candidate, startLine, startChar))
    .sort((a, b) => enclosingArea(a) - enclosingArea(b))[0]?.symbol;
}

function containsOccurrenceRange(occurrence: ScipOccurrence, line: number, char: number): boolean {
  const range = occurrence.enclosingRange ?? occurrence.enclosing_range ?? occurrence.range;
  if (!range || range.length < 3) return false;
  const startLine = range[0] ?? 0;
  const startChar = range[1] ?? 0;
  const endLine = range.length === 3 ? startLine : range[2] ?? startLine;
  const endChar = range.length === 3 ? range[2] ?? startChar : range[3] ?? startChar;
  if (line < startLine || line > endLine) return false;
  if (line === startLine && char < startChar) return false;
  if (line === endLine && char > endChar) return false;
  return true;
}

function enclosingArea(occurrence: ScipOccurrence): number {
  const range = occurrence.enclosingRange ?? occurrence.enclosing_range ?? occurrence.range ?? [0, 0, 0];
  const startLine = range[0] ?? 0;
  const startChar = range[1] ?? 0;
  const endLine = range.length === 3 ? startLine : range[2] ?? startLine;
  const endChar = range.length === 3 ? range[2] ?? startChar : range[3] ?? startChar;
  return Math.max(1, (endLine - startLine) * 10000 + (endChar - startChar));
}

function occurrenceRange(occurrence: ScipOccurrence | undefined): { startLine: number; startColumn: number; endLine: number } {
  const range = occurrence?.range ?? [];
  const startLine = Number(range[0] ?? 0) + 1;
  const startColumn = Number(range[1] ?? 0) + 1;
  const endLine = (range.length === 4 ? Number(range[2] ?? range[0] ?? 0) : Number(range[0] ?? 0)) + 1;
  return { startLine, startColumn, endLine };
}

function scipStartLine(occurrence: ScipOccurrence): number {
  return Number(occurrence.range?.[0] ?? 0) + 1;
}

function hasScipRole(occurrence: ScipOccurrence, role: number): boolean {
  return (Number(occurrence.symbolRoles ?? occurrence.symbol_roles ?? 0) & role) > 0;
}

function displayNameForScipSymbol(symbol: string, symbolsById: Map<string, ScipSymbolInformation>): string {
  const info = symbolsById.get(symbol);
  const display = info?.displayName ?? info?.display_name;
  if (display) return display;
  const descriptor = lastDescriptorName(symbol);
  return descriptor || symbol;
}

function scipSymbolToFqName(symbol: string, display: string, parent: string | undefined, kind: SymbolKind): string {
  const owner = parent ? `${parent}.` : '';
  const params = kind === 'method' || kind === 'function' ? '()' : '';
  return `${owner}${display}${params}` || symbol;
}

function lastDescriptorName(symbol: string): string {
  const withoutLocal = symbol.startsWith('local ') ? symbol.substring('local '.length) : symbol;
  const matches = [...withoutLocal.matchAll(/`([^`]+(?:``[^`]*)*)`|([^\/#\.:!\[\]\(\)\s]+)(?:\/|#|\.|:|!|\(\)\.|$)/g)];
  const raw = matches.length > 0
    ? (matches[matches.length - 1]?.[1] ?? matches[matches.length - 1]?.[2] ?? '')
    : '';
  return raw.replace(/``/g, '`');
}

function scipKindToSymbolKind(kind: string | number | undefined): SymbolKind {
  const normalized = typeof kind === 'number' ? String(kind) : String(kind ?? '').toLowerCase();
  if (normalized === '7' || normalized.includes('class')) return 'class';
  if (normalized === '21' || normalized.includes('interface')) return 'interface';
  if (normalized === '11' || normalized.includes('enum')) return 'enum';
  if (['26', '66', '80', '9'].includes(normalized) || normalized.includes('method') || normalized.includes('constructor')) return 'method';
  if (normalized === '17' || normalized.includes('function')) return 'function';
  if (normalized === '15' || normalized.includes('field') || normalized.includes('property')) return 'field';
  if (normalized === '54' || normalized.includes('typealias') || normalized === '49' || normalized.includes('struct')) return 'type';
  if (normalized === '61' || normalized === '60' || normalized === '8' || normalized.includes('variable') || normalized.includes('value') || normalized.includes('constant')) return 'variable';
  return 'variable';
}

function isContainerKind(kind: string | number | undefined): boolean {
  const mapped = scipKindToSymbolKind(kind);
  return mapped === 'class' || mapped === 'interface' || mapped === 'enum' || mapped === 'type';
}

function normalizeScipPath(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!normalized || normalized.includes('../') || normalized === '..') return undefined;
  return normalized;
}

function treeSitterFieldUsagesEnabled(): boolean {
  const value = String(process.env.CODEGRAPH_ENABLE_FIELD_USAGES ?? '').trim().toLowerCase();
  if (!value) return true;
  return value !== '0' && value !== 'false' && value !== 'no' && value !== 'off';
}

function mergeParseResults(left: ParseResult, right: ParseResult): ParseResult {
  return {
    file: left.file,
    symbols: uniqueBy([...left.symbols, ...right.symbols], symbolKey),
    imports: uniqueBy([...left.imports, ...right.imports], item => `${item.file}\0${item.source}\0${item.line}`),
    calls: uniqueBy([...left.calls, ...right.calls], item => `${item.file}\0${item.caller}\0${item.callee}\0${item.line}`),
    references: uniqueBy([...left.references, ...right.references], item => `${item.file}\0${item.symbolName}\0${item.line}\0${item.column}`),
    typeReferences: uniqueBy([...(left.typeReferences ?? []), ...(right.typeReferences ?? [])], item => `${item.file}\0${item.referencedType}\0${item.context}\0${item.line}`),
    fieldUsages: uniqueBy([...(left.fieldUsages ?? []), ...(right.fieldUsages ?? [])], item => `${item.file}\0${item.fieldName}\0${item.line}\0${item.column}\0${item.accessKind}`),
    hasParseErrors: left.hasParseErrors || right.hasParseErrors,
    parseConfidence: Math.max(left.parseConfidence, right.parseConfidence),
    packageName: left.packageName ?? right.packageName,
  };
}

function symbolKey(symbol: SymbolInfo): string {
  return `${symbol.fqName ?? symbol.name}\0${symbol.kind}\0${symbol.file}\0${symbol.line}`;
}

function uniqueBy<T>(items: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
