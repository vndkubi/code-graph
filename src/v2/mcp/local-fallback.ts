import fs from 'node:fs';
import path from 'node:path';
import { classifyFile, roleRank, type FileRole } from '../index/file-role.js';
import { loadLocalArtifactIndex, localArtifactIndexPath, rankLocalArtifactFiles } from './local-artifact.js';

export interface LocalFallbackResult {
  degraded: true;
  source: 'local_filesystem_fallback' | 'local_artifact_index';
  fallbackReason?: Record<string, unknown>;
  root: string;
  scan?: LocalFallbackScanStats;
  limitations: string[];
}

export interface LocalFallbackScanStats {
  elapsedMs: number;
  filesConsidered: number;
  filesRead: number;
  filesMatched: number;
  maxFiles: number;
  maxContentScanFiles: number;
  artifactPath?: string;
  artifactCreatedAt?: string;
}

export interface LocalContextFallbackResult extends LocalFallbackResult {
  task: string;
  mode: string;
  topFiles: string[];
  candidateFiles: LocalCandidateDto[];
  relevantSymbols: LocalSymbolDto[];
  evidenceSlices: LocalSliceDto[];
  sufficientForAnswer: boolean;
  missingFacts: string[];
  nextActions: string[];
  budget: {
    requestedTokens: number;
    estimatedResponseTokens: number;
  };
}

export interface LocalSliceFallbackResult extends LocalFallbackResult {
  slice?: LocalSliceDto;
  slices?: LocalSliceDto[];
}

export interface LocalCandidateDto {
  file: string;
  role: FileRole;
  language?: string;
  size: number;
  score: number;
  matchedTerms: string[];
  lines?: string;
}

export interface LocalSymbolDto {
  symbol: string;
  kind: string;
  file: string;
  line: number;
}

export interface LocalSliceDto {
  file: string;
  lines: string;
  startLine: number;
  endLine: number;
  text: string;
  truncated: boolean;
  matchedTerms?: string[];
}

interface LocalFile {
  absPath: string;
  relPath: string;
  size: number;
  role: FileRole;
  language?: string;
  parseable: boolean;
}

interface RankedLocalFile extends LocalFile {
  score: number;
  matchedTerms: string[];
  lineHits: number[];
  content?: string;
}

interface LocalSearchPlan {
  task: string;
  mode: string;
  explicitFiles: string[];
  tokens: string[];
  requestedTokens: number;
  maxCandidateFiles: number;
  maxEvidenceSlices: number;
}

export interface LocalMcpFallbackOptions {}

const SKIP_DIRS = new Set([
  '.codegraph',
  'benchmark-results',
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

const localScanCache = new Map<string, { expiresAt: number; files: LocalFile[] }>();

export function isLocalMcpFallbackTool(name: string): boolean {
  return name === 'codegraph_context' || name === 'codegraph_slice';
}

export function shouldUseLocalMcpFallback(): boolean {
  const raw = process.env.CODEGRAPH_MCP_LOCAL_FALLBACK;
  if (!raw) return true;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export async function runLocalMcpFallback(
  root: string,
  toolName: string,
  args: Record<string, unknown>,
  fallbackReason?: Record<string, unknown>,
  options: LocalMcpFallbackOptions = {},
): Promise<LocalContextFallbackResult | LocalSliceFallbackResult | undefined> {
  if (!shouldUseLocalMcpFallback() || !isLocalMcpFallbackTool(toolName)) return undefined;
  if (toolName === 'codegraph_context') return localCodeGraphContext(root, args, fallbackReason, options);
  return localCodeGraphSlice(root, args, fallbackReason, options);
}

export async function localCodeGraphContext(
  root: string,
  args: Record<string, unknown>,
  fallbackReason?: Record<string, unknown>,
  options: LocalMcpFallbackOptions = {},
): Promise<LocalContextFallbackResult> {
  const started = Date.now();
  const rootDir = path.resolve(root);
  const plan = buildLocalSearchPlan(args);
  const artifact = loadLocalArtifactIndex(rootDir);
  if (artifact) {
    const ranked = rankLocalArtifactFiles(artifact, plan);
    if (ranked.length > 0) {
      const selected = ranked.slice(0, plan.maxCandidateFiles);
      const evidenceSlices = buildEvidenceSlices(selected, plan);
      const estimatedResponseTokens = estimateTokens(JSON.stringify({
        topFiles: selected.map(file => file.relPath),
        candidateFiles: selected.map(candidateDto),
        evidenceSlices,
      }));

      return {
        degraded: true,
        source: 'local_artifact_index',
        fallbackReason,
        root: rootDir,
        task: plan.task,
        mode: plan.mode,
        topFiles: selected.map(file => file.relPath),
        candidateFiles: selected.map(candidateDto),
        relevantSymbols: extractSymbolsFromSlices(evidenceSlices),
        evidenceSlices,
        sufficientForAnswer: selected.length > 0,
        missingFacts: [],
        nextActions: ['Use codegraph_slice for exact lines if more source is required.', 'Run codegraph setup to refresh the embedded artifact after large source changes.'],
        budget: {
          requestedTokens: plan.requestedTokens,
          estimatedResponseTokens,
        },
        scan: {
          elapsedMs: Date.now() - started,
          filesConsidered: artifact.files.length,
          filesRead: evidenceSlices.length,
          filesMatched: ranked.length,
          maxFiles: localFallbackMaxFiles(),
          maxContentScanFiles: 0,
          artifactPath: localArtifactIndexPath(rootDir),
          artifactCreatedAt: artifact.createdAt,
        },
        limitations: localFallbackLimitations('local_artifact_index'),
      };
    }
  }
  const files = scanLocalFiles(rootDir);
  const ranked = rankLocalFiles(files, plan);
  const selected = ranked.slice(0, plan.maxCandidateFiles);
  const evidenceSlices = buildEvidenceSlices(selected, plan);
  const estimatedResponseTokens = estimateTokens(JSON.stringify({
    topFiles: selected.map(file => file.relPath),
    candidateFiles: selected.map(candidateDto),
    evidenceSlices,
  }));

  return {
    degraded: true,
    source: 'local_filesystem_fallback',
    fallbackReason,
    root: rootDir,
    task: plan.task,
    mode: plan.mode,
    topFiles: selected.map(file => file.relPath),
    candidateFiles: selected.map(candidateDto),
    relevantSymbols: extractSymbolsFromSlices(evidenceSlices),
    evidenceSlices,
    sufficientForAnswer: selected.length > 0,
    missingFacts: selected.length > 0 ? [] : ['No local source file matched the task terms.'],
    nextActions: selected.length > 0
      ? ['Use codegraph_slice for exact lines if more source is required.', 'Run codegraph index when database runtime is available for graph-aware callers/dependencies.']
      : ['Run a targeted shell search, or run codegraph index after fixing database runtime.'],
    budget: {
      requestedTokens: plan.requestedTokens,
      estimatedResponseTokens,
    },
    scan: {
      elapsedMs: Date.now() - started,
      filesConsidered: files.length,
      filesRead: ranked.readStats.filesRead,
      filesMatched: ranked.length,
      maxFiles: localFallbackMaxFiles(),
      maxContentScanFiles: localFallbackMaxContentScanFiles(),
    },
    limitations: localFallbackLimitations('local_filesystem_fallback'),
  };
}

export async function localCodeGraphSlice(
  root: string,
  args: Record<string, unknown>,
  fallbackReason?: Record<string, unknown>,
  options: LocalMcpFallbackOptions = {},
): Promise<LocalSliceFallbackResult> {
  const started = Date.now();
  const rootDir = path.resolve(root);
  const requests = Array.isArray(args.slices) && args.slices.length > 0
    ? args.slices.filter(isRecord) as Record<string, unknown>[]
    : [args];
  const maxChars = numberArg(args.maxChars, 3000);
  const slices = requests
    .map(request => localSliceOne(rootDir, request, numberArg(request.maxChars, maxChars), options))
    .filter((slice): slice is LocalSliceDto => Boolean(slice));

  return {
    degraded: true,
    source: 'local_filesystem_fallback',
    fallbackReason,
    root: rootDir,
    ...(Array.isArray(args.slices) ? { slices } : { slice: slices[0] }),
    scan: {
      elapsedMs: Date.now() - started,
      filesConsidered: 0,
      filesRead: slices.length,
      filesMatched: slices.length,
      maxFiles: localFallbackMaxFiles(),
      maxContentScanFiles: localFallbackMaxContentScanFiles(),
    },
    limitations: localFallbackLimitations('local_filesystem_fallback'),
  };
}

function buildLocalSearchPlan(args: Record<string, unknown>): LocalSearchPlan {
  const task = String(args.task ?? args.target ?? args.symbol ?? '').trim();
  const mode = typeof args.mode === 'string' ? args.mode : 'auto';
  const requestedTokens = numberArg(args.budgetTokens ?? args.tokenBudget, 6000);
  const explicitFiles = uniqueStrings([
    ...stringArray(args.files),
    ...extractFilesFromText(String(args.diff ?? '')),
    ...extractFilesFromText(task),
  ]).slice(0, 30);
  const tokens = tokenizeLocalSearch([
    task,
    String(args.target ?? ''),
    String(args.diff ?? '').slice(0, 8000),
    stringArray(args.symbols).join('\n'),
    explicitFiles.join('\n'),
  ].join('\n')).slice(0, 40);
  const profile = String(args.profile ?? 'compact');
  const maxCandidateFiles = profile === 'full' ? 15 : profile === 'micro' ? 4 : 8;
  const maxEvidenceSlices = profile === 'full' ? 8 : profile === 'micro' ? 2 : 4;
  return {
    task,
    mode,
    explicitFiles,
    tokens,
    requestedTokens,
    maxCandidateFiles,
    maxEvidenceSlices,
  };
}

function scanLocalFiles(root: string): LocalFile[] {
  const cacheKey = `${root}:${localFallbackMaxFiles()}:${localFallbackMaxFileBytes()}`;
  const cached = localScanCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.files;
  if (cached) localScanCache.delete(cacheKey);
  const files: LocalFile[] = [];
  walkLocalFiles(root, root, files);
  localScanCache.set(cacheKey, {
    expiresAt: Date.now() + localFallbackScanCacheMs(),
    files,
  });
  return files;
}

function walkLocalFiles(root: string, dir: string, files: LocalFile[]): void {
  if (files.length >= localFallbackMaxFiles()) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (files.length >= localFallbackMaxFiles()) return;
    const absPath = path.join(dir, entry.name);
    const relPath = path.relative(root, absPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (shouldSkipDir(entry.name)) continue;
      walkLocalFiles(root, absPath, files);
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
    if (stat.size > localFallbackMaxFileBytes()) continue;
    files.push({
      absPath,
      relPath,
      size: stat.size,
      role: classification.role,
      language: classification.language,
      parseable: classification.parseable,
    });
  }
}

function rankLocalFiles(files: LocalFile[], plan: LocalSearchPlan): RankedLocalFile[] & { readStats: { filesRead: number } } {
  const pathRanked = files
    .map(file => ({ file, pathScore: scorePath(file, plan) }))
    .sort((a, b) => b.pathScore.score - a.pathScore.score || roleRank(b.file.role) - roleRank(a.file.role) || a.file.relPath.localeCompare(b.file.relPath));
  const hasPathHits = pathRanked.some(item => item.pathScore.score > 0);
  const scanLimit = Math.min(
    pathRanked.length,
    hasPathHits ? localFallbackPathMissProbeFiles() : localFallbackMaxContentScanFiles(),
  );
  const ranked: RankedLocalFile[] = [];
  let filesRead = 0;

  for (let index = 0; index < pathRanked.length; index++) {
    const item = pathRanked[index]!;
    const shouldRead = item.pathScore.score > 0 || index < scanLimit;
    let contentScore = 0;
    let lineHits: number[] = [];
    let content: string | undefined;
    let contentTerms: string[] = [];
    if (shouldRead) {
      content = readTextFile(item.file.absPath, localFallbackMaxContentBytes());
      if (content !== undefined) {
        filesRead++;
        const scored = scoreContent(content, plan);
        contentScore = scored.score;
        lineHits = scored.lineHits;
        contentTerms = scored.matchedTerms;
      }
    }
    const score = item.pathScore.score + contentScore + Math.round(roleRank(item.file.role) / 20);
    const matchedTerms = uniqueStrings([...item.pathScore.matchedTerms, ...contentTerms]);
    if (score <= 0 || matchedTerms.length === 0) continue;
    ranked.push({
      ...item.file,
      score,
      matchedTerms,
      lineHits,
      content,
    });
  }

  ranked.sort((a, b) => b.score - a.score || roleRank(b.role) - roleRank(a.role) || a.relPath.localeCompare(b.relPath));
  return Object.assign(ranked, { readStats: { filesRead } });
}

function scorePath(file: LocalFile, plan: LocalSearchPlan): { score: number; matchedTerms: string[] } {
  const rel = file.relPath.toLowerCase();
  const base = path.posix.basename(rel, path.posix.extname(rel));
  const compactBase = compactText(base);
  let score = 0;
  const matchedTerms: string[] = [];

  for (const explicit of plan.explicitFiles) {
    const normalized = explicit.replace(/\\/g, '/').toLowerCase();
    if (!normalized) continue;
    if (rel === normalized || rel.endsWith(`/${normalized}`) || rel.endsWith(normalized)) {
      score += 1000;
      matchedTerms.push(explicit);
    } else if (rel.includes(normalized)) {
      score += 250;
      matchedTerms.push(explicit);
    }
  }

  for (const token of plan.tokens) {
    const lower = token.toLowerCase();
    const compact = compactText(lower);
    if (!lower || STOP_WORDS.has(lower)) continue;
    if (base === lower || compactBase === compact) {
      score += 2500;
      matchedTerms.push(token);
    } else if (base.includes(lower) || compactBase.includes(compact)) {
      score += 320;
      matchedTerms.push(token);
    } else if (rel.includes(lower)) {
      score += 140;
      matchedTerms.push(token);
    }
  }

  return { score, matchedTerms: uniqueStrings(matchedTerms) };
}

function scoreContent(content: string, plan: LocalSearchPlan): { score: number; matchedTerms: string[]; lineHits: number[] } {
  const lines = content.split(/\r?\n/);
  const lineHits: number[] = [];
  const matchedTerms: string[] = [];
  let score = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const lowerLine = line.toLowerCase();
    let lineScore = 0;
    for (const token of plan.tokens) {
      const lower = token.toLowerCase();
      if (lower.length < 2 || STOP_WORDS.has(lower)) continue;
      if (!lowerLine.includes(lower)) continue;
      matchedTerms.push(token);
      const exactIdentifier = hasExactIdentifier(line, token);
      if (isDefinitionLike(line, token) && exactIdentifier) {
        lineScore += 420;
      } else if (exactIdentifier && token.length >= 8) {
        lineScore += 90;
      } else {
        lineScore += 20;
      }
    }
    if (lineScore > 0) {
      score += Math.min(lineScore, 500);
      if (lineHits.length < 12) lineHits.push(index + 1);
    }
  }
  return {
    score,
    matchedTerms: uniqueStrings(matchedTerms),
    lineHits,
  };
}

function buildEvidenceSlices(candidates: RankedLocalFile[], plan: LocalSearchPlan): LocalSliceDto[] {
  const slices: LocalSliceDto[] = [];
  const maxChars = Math.max(800, Math.min(plan.requestedTokens * 2, 6000));
  for (const candidate of candidates) {
    if (slices.length >= plan.maxEvidenceSlices) break;
    const content = candidate.content ?? readTextFile(candidate.absPath, localFallbackMaxContentBytes());
    if (content === undefined) continue;
    const focusLine = bestLocalFocusLine(candidate);
    slices.push(sliceContent(candidate.relPath, content, focusLine, 6, maxChars, candidate.matchedTerms));
  }
  return slices;
}

function localSliceOne(
  root: string,
  request: Record<string, unknown>,
  maxChars: number,
  options: LocalMcpFallbackOptions,
): LocalSliceDto | undefined {
  const file = stringArg(request.file);
  const symbol = stringArg(request.symbol);
  if (file) {
    const absPath = safeResolve(root, file);
    if (!absPath) return undefined;
    const content = readTextFile(absPath, localFallbackMaxContentBytes());
    if (content === undefined) return undefined;
    const range = parseLineRange(stringArg(request.lines), content);
    return sliceContent(file.replace(/\\/g, '/'), content, range.startLine, range.contextLines, maxChars, []);
  }
  if (symbol) {
    const artifact = loadLocalArtifactIndex(root);
    if (artifact) {
      const rankedFromArtifact = rankLocalArtifactFiles(artifact, buildLocalSearchPlan({ task: symbol, symbol, budgetTokens: 3000 }));
      const candidateFromArtifact = rankedFromArtifact[0];
      if (candidateFromArtifact) {
        const contentFromArtifact = readTextFile(candidateFromArtifact.absPath, localFallbackMaxContentBytes());
        if (contentFromArtifact !== undefined) {
          return sliceContent(candidateFromArtifact.relPath, contentFromArtifact, bestLocalFocusLine(candidateFromArtifact), 6, maxChars, candidateFromArtifact.matchedTerms);
        }
      }
    }
    const ranked = rankLocalFiles(scanLocalFiles(root), buildLocalSearchPlan({ task: symbol, symbol, budgetTokens: 3000 }));
    const candidate = ranked[0];
    if (!candidate) return undefined;
    const content = candidate.content ?? readTextFile(candidate.absPath, localFallbackMaxContentBytes());
    if (content === undefined) return undefined;
    return sliceContent(candidate.relPath, content, bestLocalFocusLine(candidate), 6, maxChars, candidate.matchedTerms);
  }
  return undefined;
}

function bestLocalFocusLine(candidate: { lineHits: number[] }): number {
  return candidate.lineHits.find(line => line > 1) ?? candidate.lineHits[0] ?? 1;
}

function sliceContent(
  relPath: string,
  content: string,
  focusLine: number,
  contextLines: number,
  maxChars: number,
  matchedTerms: string[],
): LocalSliceDto {
  const lines = content.split(/\r?\n/);
  const startLine = Math.max(1, focusLine - contextLines);
  let endLine = Math.min(lines.length, focusLine + contextLines);
  let text = lines.slice(startLine - 1, endLine)
    .map((line, index) => `${startLine + index}: ${line}`)
    .join('\n');
  let truncated = false;
  while (text.length > maxChars && endLine > startLine) {
    truncated = true;
    endLine--;
    text = lines.slice(startLine - 1, endLine)
      .map((line, index) => `${startLine + index}: ${line}`)
      .join('\n');
  }
  if (text.length > maxChars) {
    truncated = true;
    text = text.slice(0, maxChars);
  }
  return {
    file: relPath,
    lines: `${startLine}-${endLine}`,
    startLine,
    endLine,
    text,
    truncated,
    matchedTerms,
  };
}

function parseLineRange(value: string | undefined, content: string): { startLine: number; contextLines: number } {
  if (!value) return { startLine: 1, contextLines: 80 };
  const match = /^(\d+)(?:\s*[-:]\s*(\d+))?$/.exec(value.trim());
  if (!match) return { startLine: 1, contextLines: 80 };
  const start = Math.max(1, Number(match[1]));
  const end = match[2] ? Math.max(start, Number(match[2])) : start;
  const totalLines = content.split(/\r?\n/).length;
  const clampedStart = Math.min(start, totalLines);
  return {
    startLine: clampedStart,
    contextLines: Math.max(0, Math.min(120, end - clampedStart)),
  };
}

function extractSymbolsFromSlices(slices: LocalSliceDto[]): LocalSymbolDto[] {
  const symbols: LocalSymbolDto[] = [];
  for (const slice of slices) {
    for (const line of slice.text.split(/\r?\n/)) {
      const match = /^\s*(\d+):\s*(?:export\s+)?(?:(?:public|private|protected|static|final|async)\s+)*(class|interface|enum|function|const|let|var)?\s*([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(line);
      if (!match) continue;
      const kind = match[2] ?? 'symbol';
      const symbol = match[3] ?? '';
      if (!symbol || STOP_WORDS.has(symbol.toLowerCase())) continue;
      symbols.push({
        symbol,
        kind,
        file: slice.file,
        line: Number(match[1]),
      });
      if (symbols.length >= 30) return symbols;
    }
  }
  return symbols;
}

function candidateDto(candidate: RankedLocalFile): LocalCandidateDto {
  return {
    file: candidate.relPath,
    role: candidate.role,
    language: candidate.language,
    size: candidate.size,
    score: candidate.score,
    matchedTerms: candidate.matchedTerms.slice(0, 12),
    lines: candidate.lineHits.length > 0 ? compactLineRanges(candidate.lineHits) : undefined,
  };
}

function tokenizeLocalSearch(text: string): string[] {
  const rawTokens = text.match(/[A-Za-z_$][A-Za-z0-9_$]*(?:[./_-][A-Za-z0-9_$]+)*/g) ?? [];
  const tokens: string[] = [];
  for (const raw of rawTokens) {
    const cleaned = raw.replace(/^a\//, '').replace(/^b\//, '');
    if (cleaned.length >= 2) tokens.push(cleaned);
    const split = cleaned
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9_$]+/g)
      .map(part => part.trim())
      .filter(part => part.length >= 3 && !STOP_WORDS.has(part.toLowerCase()));
    tokens.push(...split);
  }
  return uniqueStrings(tokens)
    .filter(token => token.length >= 2 && !STOP_WORDS.has(token.toLowerCase()))
    .sort((a, b) => identifierPriority(b) - identifierPriority(a));
}

function extractFilesFromText(text: string): string[] {
  const files = new Set<string>();
  for (const match of text.matchAll(/\b(?:[ab]\/)?([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]+)\b/g)) {
    const file = match[1];
    if (file) files.add(file);
  }
  return [...files];
}

function compactLineRanges(lines: number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  return sorted.slice(0, 8).join(',');
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

function safeResolve(root: string, relPath: string): string | undefined {
  const absPath = path.resolve(root, relPath);
  const relative = path.relative(root, absPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return absPath;
}

function isDefinitionLike(line: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp([
    `\\b(?:class|interface|enum|function|def)\\s+${escaped}\\b`,
    `\\b(?:const|let|var)\\s+${escaped}\\b`,
    `\\b(?:public|private|protected|static|final|async)\\s+(?:[A-Za-z_$][\\w$<>\\[\\]]+\\s+)+${escaped}\\b`,
  ].join('|'), 'i').test(line);
}

function hasExactIdentifier(line: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(line);
}

function identifierPriority(value: string): number {
  let score = value.length;
  if (/[A-Z]/.test(value) && /[a-z]/.test(value)) score += 20;
  if (value.includes('.') || value.includes('/') || value.includes('_')) score += 15;
  return score;
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item)).filter(Boolean) : [];
}

function stringArg(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function localFallbackMaxFiles(): number {
  return boundedInt(process.env.CODEGRAPH_LOCAL_FALLBACK_MAX_FILES, 50_000, 100, 500_000);
}

function localFallbackMaxFileBytes(): number {
  return boundedInt(process.env.CODEGRAPH_LOCAL_FALLBACK_MAX_FILE_BYTES, 1_000_000, 10_000, 20_000_000);
}

function localFallbackMaxContentBytes(): number {
  return boundedInt(process.env.CODEGRAPH_LOCAL_FALLBACK_MAX_CONTENT_BYTES, 250_000, 10_000, 5_000_000);
}

function localFallbackMaxContentScanFiles(): number {
  return boundedInt(process.env.CODEGRAPH_LOCAL_FALLBACK_CONTENT_SCAN_FILES, 5_000, 100, 200_000);
}

function localFallbackPathMissProbeFiles(): number {
  return boundedInt(process.env.CODEGRAPH_LOCAL_FALLBACK_PATH_MISS_PROBE_FILES, 50, 0, 50_000);
}

function localFallbackScanCacheMs(): number {
  return boundedInt(process.env.CODEGRAPH_LOCAL_FALLBACK_SCAN_CACHE_MS, 30_000, 0, 300_000);
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith('.tmp');
}

function localFallbackLimitations(source: LocalFallbackResult['source']): string[] {
  if (source === 'local_artifact_index') {
    return [
      'Embedded artifact is path/content ranked only; it does not include indexed call graph, dependency graph, or stale detection.',
      'Use it for daily orientation without DB runtime, then run codegraph index when graph-aware callers/dependencies are required.',
    ];
  }
  return [
    'Filesystem fallback is path/content ranked only; it does not include indexed call graph, dependency graph, or stale detection.',
    'Use it for orientation while DB/index runtime is unavailable, then run codegraph setup or codegraph index for faster repeated evidence.',
  ];
}
