import fs from 'node:fs';
import path from 'node:path';
import { stableId } from '../hash.js';
import { classifyFile, roleRank, type FileRole } from '../index/file-role.js';
import { ensureWorkspaceDirs, getWorkspacePaths } from '../paths.js';

export interface LocalArtifactBuildOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxContentBytes?: number;
}

export interface LocalArtifactLoadOptions {}

export interface LocalArtifactBuildResult {
  backend: 'embedded-artifact';
  root: string;
  workspaceKey: string;
  artifactPath: string;
  version: number;
  filesIndexed: number;
  filesRead: number;
  bytesRead: number;
  elapsedMs: number;
  limits: {
    maxFiles: number;
    maxFileBytes: number;
    maxContentBytes: number;
  };
}

export interface LocalArtifactStatus {
  ok: boolean;
  state: 'ready' | 'missing' | 'invalid';
  root: string;
  artifactPath: string;
  workspaceKey: string;
  version?: number;
  createdAt?: string;
  filesIndexed?: number;
  buildMs?: number;
  error?: string;
}

export interface LocalArtifactIndex {
  version: 1;
  root: string;
  workspaceKey: string;
  createdAt: string;
  buildMs: number;
  files: LocalArtifactFile[];
  stats: {
    filesIndexed: number;
    filesRead: number;
    bytesRead: number;
  };
}

export interface LocalArtifactFile {
  relPath: string;
  size: number;
  mtimeMs: number;
  role: FileRole;
  language?: string;
  parseable: boolean;
  terms: LocalArtifactTerm[];
  symbols: LocalArtifactSymbol[];
  hints: LocalArtifactHint[];
}

export interface LocalArtifactTerm {
  term: string;
  weight: number;
  lines?: number[];
}

export interface LocalArtifactSymbol {
  symbol: string;
  kind: string;
  line: number;
}

export interface LocalArtifactHint {
  line: number;
  terms: string[];
}

export interface LocalArtifactSearchPlan {
  explicitFiles: string[];
  tokens: string[];
}

export interface LocalArtifactRankedFile {
  absPath: string;
  relPath: string;
  size: number;
  role: FileRole;
  language?: string;
  parseable: boolean;
  score: number;
  matchedTerms: string[];
  lineHits: number[];
}

interface ArtifactCacheEntry {
  mtimeMs: number;
  size: number;
  index: LocalArtifactIndex;
}

interface TermBucket {
  term: string;
  weight: number;
  lines: Set<number>;
}

interface ArtifactBuildStats {
  filesIndexed: number;
  filesRead: number;
  bytesRead: number;
}

interface ArtifactPathScore {
  score: number;
  matchedTerms: string[];
  lineHits: number[];
  explicitHit: boolean;
}

const ARTIFACT_VERSION = 1;

const SKIP_DIRS = new Set([
  '.codegraph',
  '.git',
  '.idea',
  '.vscode',
  'node_modules',
  'target',
  'build',
  'dist',
  'bin',
  'obj',
  '.gradle',
  '__pycache__',
  '.tmp',
  '.cache',
  'coverage',
  'jdiff',
  'logs',
]);

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'api',
  'are',
  'be',
  'by',
  'class',
  'code',
  'context',
  'caller',
  'callers',
  'does',
  'file',
  'find',
  'flow',
  'for',
  'from',
  'get',
  'graph',
  'how',
  'implementation',
  'in',
  'include',
  'is',
  'java',
  'likely',
  'local',
  'method',
  'of',
  'or',
  'request',
  'return',
  'service',
  'slice',
  'source',
  'test',
  'tests',
  'the',
  'this',
  'to',
  'trace',
  'use',
  'used',
  'where',
  'with',
]);

const artifactCache = new Map<string, ArtifactCacheEntry>();

export function localArtifactWorkspaceKey(root: string): string {
  return stableId(['local-artifact', path.resolve(root)]);
}

export function localArtifactIndexPath(root: string): string {
  const paths = getWorkspacePaths(root);
  return path.join(paths.artifactDir, localArtifactWorkspaceKey(root), `context-index.v${ARTIFACT_VERSION}.json`);
}

export async function buildLocalArtifactIndex(
  root: string,
  options: LocalArtifactBuildOptions = {},
): Promise<LocalArtifactBuildResult> {
  const started = Date.now();
  const rootDir = path.resolve(root);
  const maxFiles = options.maxFiles ?? localArtifactMaxFiles();
  const maxFileBytes = options.maxFileBytes ?? localArtifactMaxFileBytes();
  const maxContentBytes = options.maxContentBytes ?? localArtifactMaxContentBytes();
  const paths = getWorkspacePaths(rootDir);
  ensureWorkspaceDirs(paths);

  const stats: ArtifactBuildStats = { filesIndexed: 0, filesRead: 0, bytesRead: 0 };
  const files: LocalArtifactFile[] = [];
  walkArtifactFiles(rootDir, rootDir, files, stats, {
    maxFiles,
    maxFileBytes,
    maxContentBytes,
  });

  const workspaceKey = localArtifactWorkspaceKey(rootDir);
  const index: LocalArtifactIndex = {
    version: ARTIFACT_VERSION,
    root: rootDir,
    workspaceKey,
    createdAt: new Date().toISOString(),
    buildMs: Date.now() - started,
    files,
    stats,
  };
  const artifactPath = localArtifactIndexPath(rootDir);
  writeJsonAtomic(artifactPath, index);
  artifactCache.delete(artifactPath);

  return {
    backend: 'embedded-artifact',
    root: rootDir,
    workspaceKey,
    artifactPath,
    version: ARTIFACT_VERSION,
    filesIndexed: stats.filesIndexed,
    filesRead: stats.filesRead,
    bytesRead: stats.bytesRead,
    elapsedMs: Date.now() - started,
    limits: {
      maxFiles,
      maxFileBytes,
      maxContentBytes,
    },
  };
}

export function loadLocalArtifactIndex(
  root: string,
  options: LocalArtifactLoadOptions = {},
): LocalArtifactIndex | undefined {
  const rootDir = path.resolve(root);
  const artifactPath = localArtifactIndexPath(rootDir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(artifactPath);
  } catch {
    artifactCache.delete(artifactPath);
    return undefined;
  }

  const cached = artifactCache.get(artifactPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.index;

  try {
    const parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as LocalArtifactIndex;
    if (!isLocalArtifactIndex(parsed, rootDir)) return undefined;
    artifactCache.set(artifactPath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      index: parsed,
    });
    return parsed;
  } catch {
    artifactCache.delete(artifactPath);
    return undefined;
  }
}

export function localArtifactStatus(root: string, options: LocalArtifactLoadOptions = {}): LocalArtifactStatus {
  const rootDir = path.resolve(root);
  const artifactPath = localArtifactIndexPath(rootDir);
  const workspaceKey = localArtifactWorkspaceKey(rootDir);
  if (!fs.existsSync(artifactPath)) {
    return {
      ok: false,
      state: 'missing',
      root: rootDir,
      artifactPath,
      workspaceKey,
    };
  }
  const index = loadLocalArtifactIndex(rootDir, options);
  if (!index) {
    return {
      ok: false,
      state: 'invalid',
      root: rootDir,
      artifactPath,
      workspaceKey,
      error: 'Artifact JSON could not be loaded or did not match the requested root.',
    };
  }
  return {
    ok: true,
    state: 'ready',
    root: rootDir,
    artifactPath,
    workspaceKey,
    version: index.version,
    createdAt: index.createdAt,
    filesIndexed: index.stats.filesIndexed,
    buildMs: index.buildMs,
  };
}

export function rankLocalArtifactFiles(
  index: LocalArtifactIndex,
  plan: LocalArtifactSearchPlan,
): LocalArtifactRankedFile[] {
  const pathScored = index.files.map(file => ({
    file,
    pathScore: scoreArtifactPath(file, plan),
  }));
  const explicitMatches = pathScored.filter(item => item.pathScore.explicitHit);
  const candidates = explicitMatches.length > 0 ? explicitMatches : pathScored;
  const hasPathHits = candidates.some(item => item.pathScore.score > 0);
  const ranked: LocalArtifactRankedFile[] = [];
  for (const item of candidates) {
    const scored = scoreArtifactFile(item.file, plan, item.pathScore, !hasPathHits || item.pathScore.score > 0);
    if (scored.score <= 0 || scored.matchedTerms.length === 0) continue;
    ranked.push({
      absPath: path.join(index.root, item.file.relPath),
      relPath: item.file.relPath,
      size: item.file.size,
      role: item.file.role,
      language: item.file.language,
      parseable: item.file.parseable,
      score: scored.score,
      matchedTerms: scored.matchedTerms,
      lineHits: scored.lineHits,
    });
  }
  ranked.sort((a, b) => b.score - a.score || roleRank(b.role) - roleRank(a.role) || a.relPath.localeCompare(b.relPath));
  return ranked;
}

function walkArtifactFiles(
  root: string,
  dir: string,
  files: LocalArtifactFile[],
  stats: ArtifactBuildStats,
  limits: { maxFiles: number; maxFileBytes: number; maxContentBytes: number },
): void {
  if (files.length >= limits.maxFiles) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (files.length >= limits.maxFiles) return;
    const absPath = path.join(dir, entry.name);
    const relPath = path.relative(root, absPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      walkArtifactFiles(root, absPath, files, stats, limits);
      continue;
    }
    if (!entry.isFile()) continue;

    const classification = classifyFile(relPath);
    if (!classification.indexable) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      continue;
    }
    if (stat.size > limits.maxFileBytes) continue;

    const terms = new Map<string, TermBucket>();
    addPathTerms(terms, relPath);
    const symbols: LocalArtifactSymbol[] = [];
    const hints: LocalArtifactHint[] = [];
    const content = readTextFile(absPath, limits.maxContentBytes);
    if (content !== undefined) {
      stats.filesRead++;
      stats.bytesRead += Buffer.byteLength(content, 'utf-8');
      addContentTerms(terms, content, symbols, hints);
    }

    const file: LocalArtifactFile = {
      relPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      role: classification.role,
      language: classification.language,
      parseable: classification.parseable,
      terms: finalizeTerms(terms),
      symbols,
      hints,
    };
    files.push(file);
    stats.filesIndexed++;
  }
}

function addPathTerms(terms: Map<string, TermBucket>, relPath: string): void {
  addTokenVariants(terms, relPath, 6);
  const withoutExt = relPath.replace(/\.[^.]+$/, '');
  for (const part of withoutExt.split(/[\\/._-]+/g)) {
    addTokenVariants(terms, part, 10);
  }
}

function addContentTerms(
  terms: Map<string, TermBucket>,
  content: string,
  symbols: LocalArtifactSymbol[],
  hints: LocalArtifactHint[],
): void {
  const lines = content.split(/\r?\n/);
  let genericTokens = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const lineNumber = index + 1;
    const definition = extractDefinition(line);
    if (definition && symbols.length < 80) {
      symbols.push({ ...definition, line: lineNumber });
      const lineTerms = uniqueStrings([
        definition.symbol,
        ...splitIdentifier(definition.symbol),
      ]);
      for (const term of lineTerms) addTokenVariants(terms, term, 40, lineNumber);
      hints.push({ line: lineNumber, terms: lineTerms.map(normalizeTerm).filter((term): term is string => Boolean(term)) });
    }
    for (const match of line.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*(?:[._/-][A-Za-z0-9_$]+)*/g)) {
      if (genericTokens >= 20_000) break;
      genericTokens++;
      const token = match[0] ?? '';
      addTokenVariants(terms, token, 1);
    }
  }
}

function extractDefinition(line: string): { symbol: string; kind: string } | undefined {
  const classMatch = /\b(class|interface|enum|record)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(line);
  if (classMatch?.[2]) return { kind: classMatch[1] ?? 'type', symbol: classMatch[2] };

  const functionMatch = /\b(function|def)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(line);
  if (functionMatch?.[2]) return { kind: functionMatch[1] ?? 'function', symbol: functionMatch[2] };

  const variableMatch = /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(line);
  if (variableMatch?.[1]) return { kind: 'variable', symbol: variableMatch[1] };

  const methodMatch = /^\s*(?:export\s+)?(?:(?:public|private|protected|static|final|async|abstract|override|virtual)\s+)+(?:[A-Za-z_$][A-Za-z0-9_$<>\[\],.?]*\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(line);
  if (methodMatch?.[1] && !STOP_WORDS.has(methodMatch[1].toLowerCase())) {
    return { kind: 'method', symbol: methodMatch[1] };
  }
  return undefined;
}

function finalizeTerms(terms: Map<string, TermBucket>): LocalArtifactTerm[] {
  return [...terms.values()]
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
    .slice(0, 160)
    .map(bucket => ({
      term: bucket.term,
      weight: Math.min(bucket.weight, 500),
      lines: bucket.lines.size > 0 ? [...bucket.lines].sort((a, b) => a - b).slice(0, 12) : undefined,
    }));
}

function scoreArtifactPath(
  file: LocalArtifactFile,
  plan: LocalArtifactSearchPlan,
): ArtifactPathScore {
  const rel = file.relPath.toLowerCase();
  const base = path.posix.basename(rel, path.posix.extname(rel));
  const compactBase = compactText(base);
  const matchedTerms: string[] = [];
  const lineHits: number[] = [];
  let score = 0;
  let explicitHit = false;

  for (const explicit of plan.explicitFiles) {
    const normalized = explicit.replace(/\\/g, '/').toLowerCase();
    if (!normalized) continue;
    if (rel === normalized || rel.endsWith(`/${normalized}`) || rel.endsWith(normalized)) {
      score += 50_000;
      matchedTerms.push(explicit);
      lineHits.push(1);
      explicitHit = true;
    } else if (rel.includes(normalized)) {
      score += 5_000;
      matchedTerms.push(explicit);
      explicitHit = true;
    }
  }

  for (const token of plan.tokens) {
    const lower = normalizeTerm(token);
    if (!lower) continue;
    const compact = compactText(lower);
    if (base === lower || compactBase === compact) {
      score += 2600;
      matchedTerms.push(token);
      lineHits.push(1);
    } else if (base.includes(lower) || compactBase.includes(compact)) {
      score += 360;
      matchedTerms.push(token);
    } else if (rel.includes(lower)) {
      score += 160;
      matchedTerms.push(token);
    }
  }

  return {
    score,
    matchedTerms: uniqueStrings(matchedTerms).slice(0, 16),
    lineHits: uniqueNumbers(lineHits).slice(0, 16),
    explicitHit,
  };
}

function scoreArtifactFile(
  file: LocalArtifactFile,
  plan: LocalArtifactSearchPlan,
  pathScore: ArtifactPathScore,
  includeTerms: boolean,
): { score: number; matchedTerms: string[]; lineHits: number[] } {
  const matchedTerms: string[] = [...pathScore.matchedTerms];
  const lineHits: number[] = [...pathScore.lineHits];
  let score = artifactRoleBoost(file.role) + pathScore.score;

  if (!includeTerms) {
    return {
      score,
      matchedTerms: uniqueStrings(matchedTerms).slice(0, 16),
      lineHits: uniqueNumbers(lineHits).slice(0, 16),
    };
  }

  const termByKey = new Map(file.terms.map(term => [term.term, term]));
  for (const token of plan.tokens) {
    const lower = normalizeTerm(token);
    if (!lower) continue;
    const compact = compactText(lower);
    for (const variant of termVariantsForQuery(token)) {
      const term = termByKey.get(variant);
      if (!term) continue;
      score += Math.min(1200, term.weight * 14);
      matchedTerms.push(token);
      if (term.lines) lineHits.push(...term.lines);
    }

    for (const symbol of file.symbols) {
      const symbolLower = normalizeTerm(symbol.symbol);
      if (!symbolLower) continue;
      const symbolCompact = compactText(symbolLower);
      if (symbolLower === lower || symbolCompact === compact) {
        score += 1800;
        matchedTerms.push(token);
        lineHits.push(symbol.line);
      } else if (symbolLower.includes(lower) || symbolCompact.includes(compact)) {
        score += 420;
        matchedTerms.push(token);
        lineHits.push(symbol.line);
      }
    }
  }

  for (const hint of file.hints) {
    if (hint.terms.some(term => plan.tokens.some(token => termVariantsForQuery(token).includes(term)))) {
      lineHits.push(hint.line);
    }
  }

  return {
    score,
    matchedTerms: uniqueStrings(matchedTerms).slice(0, 16),
    lineHits: uniqueNumbers(lineHits).slice(0, 16),
  };
}

function addTokenVariants(terms: Map<string, TermBucket>, raw: string, weight: number, line?: number): void {
  for (const token of [raw, ...splitIdentifier(raw), compactText(raw)]) {
    addTerm(terms, token, weight, line);
  }
}

function addTerm(terms: Map<string, TermBucket>, raw: string, weight: number, line?: number): void {
  const term = normalizeTerm(raw);
  if (!term) return;
  const bucket = terms.get(term) ?? { term, weight: 0, lines: new Set<number>() };
  bucket.weight += weight;
  if (line !== undefined) bucket.lines.add(line);
  terms.set(term, bucket);
}

function termVariantsForQuery(raw: string): string[] {
  return uniqueStrings([raw, ...splitIdentifier(raw), compactText(raw)])
    .map(normalizeTerm)
    .filter((term): term is string => Boolean(term));
}

function splitIdentifier(value: string): string[] {
  return value
    .replace(/^a\//, '')
    .replace(/^b\//, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9_$]+/g)
    .map(part => part.trim())
    .filter(part => part.length >= 3);
}

function normalizeTerm(raw: string): string | undefined {
  const term = raw.trim().replace(/^a\//, '').replace(/^b\//, '').toLowerCase();
  if (term.length < 2 || STOP_WORDS.has(term)) return undefined;
  return term;
}

function compactText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_$]+/g, '');
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.filter(value => Number.isFinite(value) && value > 0))]
    .sort((a, b) => a - b);
}

function readTextFile(filePath: string, maxBytes: number): string | undefined {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(maxBytes, fs.fstatSync(fd).size));
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(value), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}

function isLocalArtifactIndex(value: unknown, root: string): value is LocalArtifactIndex {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<LocalArtifactIndex>;
  return candidate.version === ARTIFACT_VERSION
    && path.resolve(String(candidate.root ?? '')) === root
    && Array.isArray(candidate.files)
    && Boolean(candidate.stats);
}

function localArtifactMaxFiles(): number {
  return boundedInt(process.env.CODEGRAPH_LOCAL_ARTIFACT_MAX_FILES, 200_000, 100, 1_000_000);
}

function localArtifactMaxFileBytes(): number {
  return boundedInt(process.env.CODEGRAPH_LOCAL_ARTIFACT_MAX_FILE_BYTES, 1_000_000, 10_000, 20_000_000);
}

function localArtifactMaxContentBytes(): number {
  return boundedInt(process.env.CODEGRAPH_LOCAL_ARTIFACT_MAX_CONTENT_BYTES, 250_000, 10_000, 5_000_000);
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith('.tmp');
}

function artifactRoleBoost(role: FileRole): number {
  switch (role) {
    case 'main_source': return 120;
    case 'test_source': return 20;
    case 'mock_source': return 5;
    case 'external_stub': return 0;
    case 'resource_config': return -20;
    case 'build_config': return -20;
    case 'generated': return -80;
    case 'vendored': return -200;
  }
}
