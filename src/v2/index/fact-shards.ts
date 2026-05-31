import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { CallInfo, ParseResult, SymbolInfo } from '../../analyzers/base-analyzer.js';

export interface FactShardPaths {
  parseCache: string;
  symbols: string;
  imports: string;
  typeRefs: string;
  rawCallEdges: string;
  annotations: string;
  endpoints: string;
  beans: string;
  inheritance: string;
}

export interface FactShardStats {
  parseCache: number;
  symbols: number;
  imports: number;
  typeRefs: number;
  rawCallEdges: number;
  annotations: number;
  endpoints: number;
  beans: number;
  inheritance: number;
}

export interface FactShardConfig {
  snapshotId: string;
  providerId: string;
  providerVersion: string;
  createdAt: string;
}

export interface FactShardFile {
  relPath: string;
  blobHash: string;
  language: string;
  role: string;
  cacheInsert: boolean;
}

export interface ClassifiedCallEdge {
  caller: string;
  callee: string;
  confidence: number;
  signalTier: CallSignalTier;
  signalReasons: string[];
}

export interface RawCallFact {
  rawLine: string;
  snapshotId: string;
  caller: string;
  callee: string;
  file: string;
  line: number;
  confidence: number;
  resolutionKind: string;
  fileRole: string;
  signalTier: CallSignalTier;
  signalReasonsJson: string;
}

type CallSignalTier = 'primary' | 'low_signal' | 'provider';
type FactShardTable = keyof FactShardPaths;
type CopyValue = string | number | null | undefined;

const FACT_SHARD_BUFFER_BYTES = positiveInt(process.env.CODEGRAPH_FACT_SHARD_BUFFER_BYTES, 1024 * 1024);
const MAX_CALL_ENDPOINT_LENGTH = 2048;
const CALL_ENDPOINT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const LOW_SIGNAL_UNQUALIFIED_CALLS = new Set([
  'assertArrayEquals',
  'assertEquals',
  'assertFalse',
  'assertNotEquals',
  'assertNotNull',
  'assertNull',
  'assertSame',
  'assertThat',
  'assertThrows',
  'assertTrue',
  'containsString',
  'empty',
  'equalTo',
  'expectThrows',
  'fail',
  'greaterThan',
  'greaterThanOrEqualTo',
  'hasSize',
  'instanceOf',
  'is',
  'lessThan',
  'lessThanOrEqualTo',
  'mock',
  'never',
  'not',
  'notNullValue',
  'nullValue',
  'randomAlphaOfLength',
  'randomBoolean',
  'randomFrom',
  'randomInt',
  'randomIntBetween',
  'sameInstance',
  'verify',
  'when',
]);

const BEAN_ANNOTATIONS = new Set([
  'Singleton',
  'ApplicationScoped',
  'RequestScoped',
  'SessionScoped',
  'Stateless',
  'Stateful',
  'ConversationScoped',
  'Dependent',
  'Named',
  'ManagedBean',
  'Model',
  'MessageDriven',
  'TransactionScoped',
  'ViewScoped',
  'FlowScoped',
  'ClientWindowScoped',
  'NoneScoped',
  'CustomScoped',
  'Service',
  'Component',
  'Repository',
  'Controller',
  'RestController',
]);

const HTTP_METHOD_ANNOTATIONS = new Map([
  ['GET', 'GET'],
  ['POST', 'POST'],
  ['PUT', 'PUT'],
  ['DELETE', 'DELETE'],
  ['PATCH', 'PATCH'],
  ['HEAD', 'HEAD'],
  ['OPTIONS', 'OPTIONS'],
  ['GetMapping', 'GET'],
  ['PostMapping', 'POST'],
  ['PutMapping', 'PUT'],
  ['DeleteMapping', 'DELETE'],
  ['PatchMapping', 'PATCH'],
  ['RequestMapping', 'REQUEST'],
]);

export function factShardPathsForWorker(tmpDir: string, index: number): FactShardPaths {
  const prefix = path.join(tmpDir, `${index}.fact`);
  return {
    parseCache: `${prefix}.parse_cache.copy`,
    symbols: `${prefix}.symbols.copy`,
    imports: `${prefix}.imports.copy`,
    typeRefs: `${prefix}.type_refs.copy`,
    rawCallEdges: `${prefix}.raw_call_edges.copy`,
    annotations: `${prefix}.annotations.copy`,
    endpoints: `${prefix}.endpoints.copy`,
    beans: `${prefix}.beans.copy`,
    inheritance: `${prefix}.inheritance.copy`,
  };
}

export function emptyFactShardStats(): FactShardStats {
  return {
    parseCache: 0,
    symbols: 0,
    imports: 0,
    typeRefs: 0,
    rawCallEdges: 0,
    annotations: 0,
    endpoints: 0,
    beans: 0,
    inheritance: 0,
  };
}

export function addFactShardStats(total: FactShardStats, next: FactShardStats): void {
  total.parseCache += next.parseCache;
  total.symbols += next.symbols;
  total.imports += next.imports;
  total.typeRefs += next.typeRefs;
  total.rawCallEdges += next.rawCallEdges;
  total.annotations += next.annotations;
  total.endpoints += next.endpoints;
  total.beans += next.beans;
  total.inheritance += next.inheritance;
}

export interface FactShardWriter {
  readonly paths: FactShardPaths;
  readonly stats: FactShardStats;
  readonly symbolKeys: Set<string>;
  close(): void;
}

export function openFactShardWriter(paths: FactShardPaths): FactShardWriter {
  const fds = new Map<FactShardTable, number>();
  const buffers = new Map<FactShardTable, string>();
  for (const [table, filePath] of Object.entries(paths) as Array<[FactShardTable, string]>) {
    fds.set(table, fs.openSync(filePath, 'w'));
    buffers.set(table, '');
  }

  const stats = emptyFactShardStats();
  const getFd = (table: FactShardTable): number => {
    const fd = fds.get(table);
    if (fd === undefined) throw new Error(`Fact shard writer for ${table} is closed.`);
    return fd;
  };
  return {
    paths,
    stats,
    symbolKeys: new Set<string>(),
    close() {
      for (const [table, fd] of fds.entries()) {
        const buffered = buffers.get(table) ?? '';
        if (buffered.length > 0) fs.writeSync(fd, buffered);
        fs.closeSync(fd);
      }
      fds.clear();
      buffers.clear();
    },
    getFd(table: FactShardTable): number {
      return getFd(table);
    },
    writeLine(table: FactShardTable, line: string): void {
      const fd = getFd(table);
      const buffered = buffers.get(table) ?? '';
      if (buffered.length > 0 && buffered.length + line.length > FACT_SHARD_BUFFER_BYTES) {
        fs.writeSync(fd, buffered);
        buffers.set(table, '');
      }
      if (line.length >= FACT_SHARD_BUFFER_BYTES) {
        fs.writeSync(fd, line);
      } else {
        buffers.set(table, (buffers.get(table) ?? '') + line);
      }
    },
  } as FactShardWriter;
}

export function writeParseResultFactRows(
  writer: FactShardWriter,
  config: FactShardConfig,
  file: FactShardFile,
  result: ParseResult,
): void {
  if (file.cacheInsert) {
    writeRow(writer, 'parseCache', [
      config.providerId,
      config.providerVersion,
      file.blobHash,
      file.language,
      JSON.stringify(result),
      result.hasParseErrors ? 1 : 0,
      result.parseConfidence,
      config.createdAt,
    ]);
  }

  const classesByName = new Map<string, SymbolInfo>();
  for (const sym of result.symbols) {
    if ((sym.kind === 'class' || sym.kind === 'interface') && sym.name) {
      classesByName.set(sym.name, sym);
    }
  }

  for (const sym of result.symbols) {
    const fqName = symbolFqName(sym);
    const symbolKey = `${config.snapshotId}\0${fqName}\0${file.relPath}\0${sym.line}`;
    if (!writer.symbolKeys.has(symbolKey)) {
      writer.symbolKeys.add(symbolKey);
      writeRow(writer, 'symbols', [
        config.snapshotId,
        fqName,
        sym.name,
        sym.kind,
        file.relPath,
        sym.line,
        sym.column,
        sym.endLine,
        sym.signature,
        sym.visibility,
        sym.parent,
        sym.packageName,
        sym.returnType,
        JSON.stringify(sym.parameterTypes ?? []),
        JSON.stringify(sym.annotations ?? []),
        sym.frameworkRole,
        JSON.stringify(sym.frameworkMeta ?? {}),
        file.role,
      ]);
    }

    for (const annotation of sym.annotations ?? []) {
      writeRow(writer, 'annotations', [config.snapshotId, fqName, annotation, file.relPath, sym.line]);
    }

    const child = fqName.replace(/\([^)]*\)$/, '');
    if (sym.extends) {
      writeRow(writer, 'inheritance', [config.snapshotId, child, sym.extends, 'extends', file.relPath, sym.line, 0.8]);
    }
    for (const parent of sym.implements ?? []) {
      writeRow(writer, 'inheritance', [config.snapshotId, child, parent, 'implements', file.relPath, sym.line, 0.8]);
    }

    const beanRow = beanRowForSymbol(config.snapshotId, file, sym, fqName);
    if (beanRow) writeRow(writer, 'beans', beanRow);
    const endpointRow = endpointRowForSymbol(config.snapshotId, file, sym, fqName, classesByName);
    if (endpointRow) writeRow(writer, 'endpoints', endpointRow);
  }

  for (const imp of result.imports) {
    writeRow(writer, 'imports', [
      config.snapshotId,
      file.relPath,
      imp.source,
      JSON.stringify(imp.symbols),
      imp.line,
      imp.isExternal ? 1 : 0,
      file.role,
    ]);
  }

  for (const ref of result.typeReferences ?? []) {
    writeRow(writer, 'typeRefs', [config.snapshotId, file.relPath, ref.referencedType, ref.context, ref.line, file.role]);
  }

  for (const call of result.calls) {
    const normalizedCall = classifyCallEdge(call);
    if (!normalizedCall) continue;
    writeRow(writer, 'rawCallEdges', [
      config.snapshotId,
      normalizedCall.caller,
      normalizedCall.callee,
      file.relPath,
      call.line,
      normalizedCall.confidence,
      call.resolutionKind ?? 'name-only',
      file.role,
      normalizedCall.signalTier,
      JSON.stringify(normalizedCall.signalReasons),
    ]);
  }
}

export function classifyCallEdge(call: {
  caller: string;
  callee: string;
  confidence?: number;
  resolutionKind?: string;
}): ClassifiedCallEdge | undefined {
  const semanticProviderCall = call.resolutionKind === 'scip-reference';
  const caller = normalizedCallEndpoint(call.caller, semanticProviderCall);
  const callee = normalizedCallEndpoint(call.callee, semanticProviderCall);
  if (!caller || !callee) return undefined;
  const baseConfidence = call.confidence ?? 0.4;
  if (semanticProviderCall) {
    return {
      caller,
      callee,
      confidence: Math.max(baseConfidence, 0.9),
      signalTier: 'provider',
      signalReasons: ['semantic provider fact'],
    };
  }

  const signalReasons: string[] = [];
  if (!CALL_ENDPOINT_PATTERN.test(caller)) signalReasons.push('caller is an expression');
  if (!CALL_ENDPOINT_PATTERN.test(callee)) signalReasons.push('callee is an expression');
  if (!callee.includes('.') && LOW_SIGNAL_UNQUALIFIED_CALLS.has(callee)) {
    signalReasons.push('low-signal unqualified helper call');
  }

  const signalTier: CallSignalTier = signalReasons.length > 0 ? 'low_signal' : 'primary';
  return {
    caller,
    callee,
    confidence: signalTier === 'low_signal' ? Math.min(baseConfidence, 0.25) : baseConfidence,
    signalTier,
    signalReasons,
  };
}

export function* readRawCallFacts(filePath: string): Iterable<RawCallFact> {
  for (const line of readCopyTextLines(filePath)) {
    const values = line.includes('\\') ? parseCopyTextRow(line) : line.split('\t');
    if (values.length !== 10) {
      throw new Error(`Expected 10 raw call fact columns in ${filePath}, received ${values.length}.`);
    }
    yield {
      rawLine: line,
      snapshotId: values[0] ?? '',
      caller: values[1] ?? '',
      callee: values[2] ?? '',
      file: values[3] ?? '',
      line: Number(values[4] ?? 0),
      confidence: Number(values[5] ?? 0),
      resolutionKind: values[6] ?? 'name-only',
      fileRole: values[7] ?? '',
      signalTier: rawCallSignalTier(values[8]),
      signalReasonsJson: values[9] ?? '[]',
    };
  }
}

export function createCopyTextWriter(filePath: string): CopyTextWriter {
  return new CopyTextWriter(filePath);
}

export class CopyTextWriter {
  private fd: number | undefined;
  private buffer = '';
  rows = 0;

  constructor(filePath: string) {
    this.fd = fs.openSync(filePath, 'w');
  }

  write(values: CopyValue[]): void {
    if (this.fd === undefined) throw new Error('COPY text writer is closed.');
    this.writeBuffered(`${values.map(copyTextValue).join('\t')}\n`);
    this.rows++;
  }

  writeRawLine(line: string): void {
    if (this.fd === undefined) throw new Error('COPY text writer is closed.');
    this.writeBuffered(`${line}\n`);
    this.rows++;
  }

  close(): void {
    if (this.fd === undefined) return;
    if (this.buffer.length > 0) {
      fs.writeSync(this.fd, this.buffer);
      this.buffer = '';
    }
    fs.closeSync(this.fd);
    this.fd = undefined;
  }

  private writeBuffered(line: string): void {
    if (this.fd === undefined) throw new Error('COPY text writer is closed.');
    if (this.buffer.length > 0 && this.buffer.length + line.length > FACT_SHARD_BUFFER_BYTES) {
      fs.writeSync(this.fd, this.buffer);
      this.buffer = '';
    }
    if (line.length >= FACT_SHARD_BUFFER_BYTES) {
      fs.writeSync(this.fd, line);
    } else {
      this.buffer += line;
    }
  }
}

function writeRow(writer: FactShardWriter, table: FactShardTable, values: CopyValue[]): void {
  (writer as FactShardWriter & { writeLine(table: FactShardTable, line: string): void })
    .writeLine(table, `${values.map(copyTextValue).join('\t')}\n`);
  writer.stats[table]++;
}

function* readCopyTextLines(filePath: string): Iterable<string> {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const decoder = new StringDecoder('utf-8');
  let pending = '';

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = pending + decoder.write(buffer.subarray(0, bytesRead));
      const lines = chunk.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line) yield line;
      }
    }
    pending += decoder.end();
    if (pending) yield pending;
  } finally {
    fs.closeSync(fd);
  }
}

function parseCopyTextRow(line: string): Array<string | undefined> {
  const values: Array<string | undefined> = [];
  let current = '';
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index] ?? '';
    if (escaped) {
      switch (char) {
        case 'N':
          current += '\\N';
          break;
        case 't':
          current += '\t';
          break;
        case 'n':
          current += '\n';
          break;
        case 'r':
          current += '\r';
          break;
        case '\\':
          current += '\\';
          break;
        default:
          current += char;
          break;
      }
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '\t') {
      values.push(current === '\\N' ? undefined : current);
      current = '';
      continue;
    }
    current += char;
  }
  if (escaped) current += '\\';
  values.push(current === '\\N' ? undefined : current);
  return values;
}

function copyTextValue(value: CopyValue): string {
  if (value === null || value === undefined) return '\\N';
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function parseSignalReasons(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function rawCallSignalTier(value: string | undefined): CallSignalTier {
  return value === 'low_signal' || value === 'provider' ? value : 'primary';
}

interface EndpointPathResolution {
  path: string;
  resolution: 'exact' | 'partial';
  reason?: string;
}

function beanRowForSymbol(snapshotId: string, file: FactShardFile, sym: SymbolInfo, fqName: string): CopyValue[] | undefined {
  if (sym.kind !== 'class' && sym.kind !== 'interface') return undefined;
  const annotations = sym.annotations ?? [];
  const beanAnnotation = annotations.find(a => BEAN_ANNOTATIONS.has(a));
  if (!beanAnnotation) return undefined;
  return [
    snapshotId,
    sym.name,
    fqName,
    beanAnnotation,
    JSON.stringify(annotations.filter(a => a.endsWith('Qualifier'))),
    'annotation',
    file.relPath,
    sym.line,
    0.8,
  ];
}

function endpointRowForSymbol(
  snapshotId: string,
  file: FactShardFile,
  sym: SymbolInfo,
  fqName: string,
  classesByName: Map<string, SymbolInfo>,
): CopyValue[] | undefined {
  const annotations = sym.annotations ?? [];

  if (sym.kind === 'class' || sym.kind === 'interface') {
    if (annotations.includes('ServerEndpoint')) {
      const endpointPath = resolveClassEndpointPath(sym);
      return [
        snapshotId,
        'WEBSOCKET',
        endpointPath.path,
        endpointPath.resolution,
        endpointPath.reason,
        fqName,
        sym.name,
        file.relPath,
        sym.line,
        'websocket',
        endpointPath.resolution === 'exact' ? 0.8 : 0.5,
        file.role,
      ];
    }

    if (annotations.includes('WebServlet')) {
      const endpointPath = resolveClassEndpointPath(sym);
      return [
        snapshotId,
        'SERVLET',
        endpointPath.path,
        endpointPath.resolution,
        endpointPath.reason,
        fqName,
        sym.name,
        file.relPath,
        sym.line,
        'servlet',
        endpointPath.resolution === 'exact' ? 0.75 : 0.5,
        file.role,
      ];
    }
  }

  if (sym.kind !== 'method') return undefined;

  if (
    sym.frameworkRole === 'openapi:endpoint'
    || sym.frameworkRole === 'postman:request'
    || sym.frameworkRole === 'elastic-rest:endpoint'
  ) {
    const method = String(sym.frameworkMeta?.httpMethod ?? 'GET').toUpperCase();
    const endpointPath = String(sym.frameworkMeta?.path ?? '/');
    const framework = sym.frameworkRole === 'elastic-rest:endpoint'
      ? 'elastic-rest'
      : sym.frameworkRole.startsWith('openapi') ? 'openapi' : 'postman';
    return [
      snapshotId,
      method,
      endpointPath,
      'exact',
      null,
      fqName,
      sym.parent,
      file.relPath,
      sym.line,
      framework,
      0.75,
      file.role,
    ];
  }

  const methodAnnotation = annotations.find(a => HTTP_METHOD_ANNOTATIONS.has(a));
  if (!methodAnnotation) return undefined;

  const httpMethod = sym.frameworkMeta?.httpMethod ?? HTTP_METHOD_ANNOTATIONS.get(methodAnnotation) ?? 'REQUEST';
  const endpointPath = resolveEndpointPath(sym, classesByName.get(sym.parent ?? ''));
  return [
    snapshotId,
    httpMethod,
    endpointPath.path,
    endpointPath.resolution,
    endpointPath.reason,
    fqName,
    sym.parent,
    file.relPath,
    sym.line,
    methodAnnotation.includes('Mapping') ? 'spring' : 'jakarta',
    endpointPath.resolution === 'exact' ? 0.85 : 0.55,
    file.role,
  ];
}

function resolveEndpointPath(methodSym: SymbolInfo, classSym: SymbolInfo | undefined): EndpointPathResolution {
  const classMeta = classSym?.frameworkMeta ?? {};
  const methodMeta = methodSym.frameworkMeta ?? {};
  const classPath = classMeta.path;
  const methodPath = methodMeta.path;
  const path = composeEndpointPath(classPath, methodPath);
  const reasons = [
    classMeta.pathResolution === 'partial' ? classMeta.pathResolutionReason : undefined,
    methodMeta.pathResolution === 'partial' ? methodMeta.pathResolutionReason : undefined,
  ].filter((reason): reason is string => Boolean(reason));

  if (reasons.length > 0) {
    return { path, resolution: 'partial', reason: reasons.join('; ') };
  }
  if (classPath === undefined && methodPath === undefined) {
    return {
      path,
      resolution: 'partial',
      reason: 'No class-level or method-level path literal/constant was found; using root fallback.',
    };
  }
  return { path, resolution: 'exact' };
}

function resolveClassEndpointPath(sym: SymbolInfo): EndpointPathResolution {
  const meta = sym.frameworkMeta ?? {};
  const path = composeEndpointPath(meta.path, undefined);
  if (meta.pathResolution === 'partial') {
    return {
      path,
      resolution: 'partial',
      reason: meta.pathResolutionReason,
    };
  }
  if (meta.path === undefined) {
    return {
      path,
      resolution: 'partial',
      reason: 'No class-level path literal/constant was found; using root fallback.',
    };
  }
  return { path, resolution: 'exact' };
}

function composeEndpointPath(classPath: string | undefined, methodPath: string | undefined): string {
  const parts = [classPath, methodPath]
    .filter((part): part is string => part !== undefined)
    .map(part => part.trim())
    .filter(part => part.length > 0 && part !== '/');
  if (parts.length === 0) return '/';
  const joined = parts
    .map((part, index) => index === 0 ? part.replace(/\/+$/g, '') : part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

function normalizedCallEndpoint(value: string, allowProviderSymbol: boolean): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_CALL_ENDPOINT_LENGTH) return undefined;
  if (/[\r\n]/.test(trimmed)) return undefined;
  if (allowProviderSymbol) return trimmed;
  return trimmed;
}

function simpleTypeName(typeName: string): string {
  const withoutParams = typeName.replace(/\([^)]*\)$/, '');
  const parts = withoutParams.split('.').filter(Boolean);
  return parts[parts.length - 1] ?? withoutParams;
}

function symbolFqName(symbol: {
  fqName?: string;
  packageName?: string;
  parent?: string;
  name: string;
  kind: string;
  parameterTypes?: string[];
}): string {
  if (symbol.fqName) return symbol.fqName;
  const owner = symbol.parent ? `${symbol.parent}.` : '';
  const params = symbol.kind === 'method' || symbol.kind === 'function'
    ? `(${(symbol.parameterTypes ?? []).join(',')})`
    : '';
  const packagePrefix = symbol.packageName ? `${symbol.packageName}.` : '';
  return `${packagePrefix}${owner}${symbol.name}${params}`;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}
