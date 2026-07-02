/**
 * CI review: run the deterministic review_patch engine over a git ref range
 * and render the findings for CI surfaces — SARIF for GitHub code scanning,
 * markdown for a sticky PR comment, plain text for job logs. No LLM anywhere:
 * every finding is a graph/diff fact with a stable rule id, so the same diff
 * always produces the same report.
 */
import { execFileSync } from 'node:child_process';
import { isIgnorableChangedPath } from './ci-test-selection.js';
import { V2QueryService } from './service.js';

export type CiReviewFormat = 'json' | 'sarif' | 'markdown' | 'text';
export type CiReviewPriority = 'P0' | 'P1' | 'P2';
export type CiReviewFailOn = CiReviewPriority | 'none';

export interface CiReviewOptions {
  baseRef: string;
  headRef?: string;
  focus?: string;
  limit?: number;
  /** Drop findings below this priority (P0 strictest). Default: keep all. */
  minPriority?: CiReviewPriority;
}

export interface CiReviewFinding {
  /** Instance id from the engine (may embed file/symbol). */
  id: string;
  /** Stable rule id (instance suffixes stripped) — SARIF rules group on this. */
  ruleId: string;
  priority: CiReviewPriority;
  category?: string;
  file?: string;
  line?: number;
  title: string;
  why: string;
  suggestedCheck?: string;
  suggestedFix?: string;
  confidence: number;
  evidence?: unknown;
}

export interface CiReviewResult {
  baseRef: string;
  headRef: string;
  changedFiles: string[];
  /** Changed paths excluded from review (docs, licenses, index artifacts…). */
  ignoredFiles: string[];
  reviewStatus?: string;
  diffStats?: Record<string, unknown>;
  findings: CiReviewFinding[];
  priorityCounts: Record<CiReviewPriority, number>;
  droppedBelowMinPriority: number;
}

const GIT_DIFF_TIMEOUT_MS = 30_000;

/**
 * Unified diff for merge-base(base, head)..head — `base...head`, the same
 * range a GitHub PR shows. Throws when git cannot answer: a review built from
 * an unknown diff would be a guess.
 */
export function gitUnifiedDiff(root: string, baseRef: string, headRef = 'HEAD'): string {
  return execFileSync('git', ['diff', '--no-renames', '--unified=3', `${baseRef}...${headRef}`], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_DIFF_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
}

// Longest-prefix-first so 'review-duplicated-code-existing' wins over
// 'review-duplicated-code'. Anything unknown keeps its full id as the rule.
const RULE_ID_PREFIXES = [
  'review-duplicated-code-existing',
  'review-duplicated-code',
  'review-stale-caller',
  'review-large-class',
  'review-long-method',
  'review-long-param-list',
  'review-dead-code',
  'review-feature-envy',
  'review-secret',
  'review-command-exec',
  'review-broad-catch',
  'review-debug-output',
  'review-removed-assertion',
  'review-sql-concat',
];

export function ruleIdForFinding(id: string): string {
  for (const prefix of RULE_ID_PREFIXES) {
    if (id === prefix || id.startsWith(`${prefix}-`)) return prefix;
  }
  return id;
}

const PRIORITY_RANK: Record<CiReviewPriority, number> = { P0: 0, P1: 1, P2: 2 };

function normalizePriority(value: unknown): CiReviewPriority {
  return value === 'P0' || value === 'P1' || value === 'P2' ? value : 'P2';
}

function emptyResult(baseRef: string, headRef: string, reviewStatus: string, ignoredFiles: string[] = []): CiReviewResult {
  return {
    baseRef,
    headRef,
    changedFiles: [],
    ignoredFiles,
    reviewStatus,
    findings: [],
    priorityCounts: { P0: 0, P1: 0, P2: 0 },
    droppedBelowMinPriority: 0,
  };
}

/**
 * Strip per-file diff blocks whose path can never affect reviewable code
 * (docs, licenses, CodeGraph's own artifacts). Without this, a README-only PR
 * earns a P1 "unresolved inputs" finding because markdown is not indexed.
 * A block whose header cannot be parsed is KEPT — over-reviewing is safe,
 * silently skipping code is not.
 */
export function filterIgnorableDiff(diff: string): { diff: string; ignoredFiles: string[] } {
  const blocks = diff.split(/^(?=diff --git )/m);
  const kept: string[] = [];
  const ignoredFiles: string[] = [];
  for (const block of blocks) {
    if (block.trim() === '') continue;
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(block);
    const file = (header?.[2] ?? '').trim();
    if (file !== '' && isIgnorableChangedPath(file)) {
      ignoredFiles.push(file);
      continue;
    }
    kept.push(block);
  }
  return { diff: kept.join(''), ignoredFiles };
}

/**
 * Run the review engine over `baseRef...headRef`. The workspace must already
 * be indexed at the head state (`workspaceId` from V2Indexer.indexWorkspace).
 */
export async function reviewForCi(
  service: V2QueryService,
  workspaceId: string,
  root: string,
  options: CiReviewOptions,
): Promise<CiReviewResult> {
  const headRef = options.headRef ?? 'HEAD';
  const rawDiff = gitUnifiedDiff(root, options.baseRef, headRef);
  if (rawDiff.trim() === '') {
    return emptyResult(options.baseRef, headRef, 'no-changes');
  }
  const { diff, ignoredFiles } = filterIgnorableDiff(rawDiff);
  if (diff.trim() === '') {
    return emptyResult(options.baseRef, headRef, 'no-reviewable-changes', ignoredFiles);
  }
  const response = await service.query({
    workspaceId,
    toolName: 'review_patch',
    args: {
      diff,
      focus: options.focus ?? 'general',
      limit: options.limit ?? 50,
      outputMode: 'full',
    },
  }) as Record<string, unknown>;

  const rawFindings = Array.isArray(response.reviewFindings) ? response.reviewFindings : [];
  const all: CiReviewFinding[] = rawFindings
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
    .map(f => {
      const id = String(f.id ?? 'review-finding');
      return {
        id,
        ruleId: ruleIdForFinding(id),
        priority: normalizePriority(f.priority),
        category: typeof f.category === 'string' ? f.category : undefined,
        file: typeof f.file === 'string' ? f.file : undefined,
        line: typeof f.line === 'number' && Number.isFinite(f.line) ? f.line : undefined,
        title: String(f.title ?? id),
        why: String(f.why ?? ''),
        suggestedCheck: typeof f.suggestedCheck === 'string' ? f.suggestedCheck : undefined,
        suggestedFix: typeof f.suggestedFix === 'string' ? f.suggestedFix : undefined,
        confidence: typeof f.confidence === 'number' ? f.confidence : 0.5,
        evidence: f.evidence,
      };
    });

  const maxRank = PRIORITY_RANK[options.minPriority ?? 'P2'];
  const findings = all.filter(f => PRIORITY_RANK[f.priority] <= maxRank);
  const priorityCounts: Record<CiReviewPriority, number> = { P0: 0, P1: 0, P2: 0 };
  for (const finding of findings) priorityCounts[finding.priority] += 1;

  return {
    baseRef: options.baseRef,
    headRef,
    changedFiles: Array.isArray(response.changedFiles) ? response.changedFiles.map(String) : [],
    ignoredFiles,
    reviewStatus: typeof response.reviewStatus === 'string' ? response.reviewStatus : undefined,
    diffStats: typeof response.diffStats === 'object' && response.diffStats !== null
      ? response.diffStats as Record<string, unknown>
      : undefined,
    findings,
    priorityCounts,
    droppedBelowMinPriority: all.length - findings.length,
  };
}

/** Exit code for a CI gate: fail when any finding is at or above `failOn`. */
export function ciReviewExitCode(result: CiReviewResult, failOn: CiReviewFailOn): number {
  if (failOn === 'none') return 0;
  const threshold = PRIORITY_RANK[failOn];
  return result.findings.some(f => PRIORITY_RANK[f.priority] <= threshold) ? 1 : 0;
}

const SARIF_LEVEL: Record<CiReviewPriority, string> = { P0: 'error', P1: 'warning', P2: 'note' };

export function formatCiReview(result: CiReviewResult, format: CiReviewFormat, toolVersion = '0.0.0'): string {
  switch (format) {
    case 'json':
      return JSON.stringify(result, null, 2);
    case 'sarif':
      return JSON.stringify(toSarif(result, toolVersion), null, 2);
    case 'markdown':
      return toMarkdown(result);
    case 'text':
      return toText(result);
  }
}

function toSarif(result: CiReviewResult, toolVersion: string): Record<string, unknown> {
  const rules = new Map<string, Record<string, unknown>>();
  for (const finding of result.findings) {
    if (rules.has(finding.ruleId)) continue;
    rules.set(finding.ruleId, {
      id: finding.ruleId,
      name: finding.ruleId,
      shortDescription: { text: finding.title },
      helpUri: 'https://github.com/vndkubi/code-graph#codegraph-review',
      defaultConfiguration: { level: SARIF_LEVEL[finding.priority] },
      properties: finding.category ? { category: finding.category } : {},
    });
  }
  const fallbackFile = result.changedFiles[0];
  const results = result.findings.map(finding => {
    const file = finding.file ?? fallbackFile;
    const message = [
      finding.title,
      finding.why,
      finding.suggestedCheck ? `Check: ${finding.suggestedCheck}` : undefined,
      finding.suggestedFix ? `Fix: ${finding.suggestedFix}` : undefined,
    ].filter(Boolean).join(' — ');
    return {
      ruleId: finding.ruleId,
      level: SARIF_LEVEL[finding.priority],
      message: { text: message },
      // GitHub code scanning requires a physical location; findings without a
      // file anchor fall back to the first changed file at line 1.
      locations: file
        ? [{
          physicalLocation: {
            artifactLocation: { uri: file.replace(/\\/g, '/') },
            region: { startLine: finding.line && finding.line > 0 ? finding.line : 1 },
          },
        }]
        : [],
      partialFingerprints: { codegraphFindingId: finding.id },
      properties: { priority: finding.priority, confidence: finding.confidence },
    };
  });
  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'codegraph-review',
          informationUri: 'https://github.com/vndkubi/code-graph',
          version: toolVersion,
          rules: [...rules.values()],
        },
      },
      results,
    }],
  };
}

/** Marker used to find and update the sticky PR comment in place. */
export const CI_REVIEW_COMMENT_MARKER = '<!-- codegraph-review -->';

function toMarkdown(result: CiReviewResult): string {
  const lines: string[] = [];
  const total = result.findings.length;
  lines.push(`### CodeGraph review — ${total === 0 ? 'no findings' : `${total} finding(s)`}`);
  lines.push('');
  lines.push(`\`${result.baseRef}...${result.headRef}\` · ${result.changedFiles.length} changed file(s) · deterministic graph facts, no LLM`);
  if (total > 0) {
    lines.push('');
    lines.push('| Priority | Rule | Location | Finding |');
    lines.push('|---|---|---|---|');
    for (const finding of result.findings) {
      const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}` : '—';
      const detail = `**${escapeMarkdownCell(finding.title)}** — ${escapeMarkdownCell(finding.why)}`;
      lines.push(`| ${finding.priority} | \`${finding.ruleId}\` | ${escapeMarkdownCell(location)} | ${detail} |`);
    }
  }
  if (result.droppedBelowMinPriority > 0) {
    lines.push('');
    lines.push(`<sub>${result.droppedBelowMinPriority} lower-priority finding(s) hidden by the min-priority filter.</sub>`);
  }
  lines.push('');
  lines.push(CI_REVIEW_COMMENT_MARKER);
  return lines.join('\n');
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function toText(result: CiReviewResult): string {
  const lines: string[] = [];
  lines.push(`codegraph review ${result.baseRef}...${result.headRef}: ${result.findings.length} finding(s) across ${result.changedFiles.length} changed file(s)`);
  for (const finding of result.findings) {
    const location = finding.file ? ` [${finding.file}${finding.line ? `:${finding.line}` : ''}]` : '';
    lines.push(`${finding.priority} ${finding.ruleId}${location}: ${finding.title}`);
    lines.push(`   ${finding.why}`);
    if (finding.suggestedCheck) lines.push(`   check: ${finding.suggestedCheck}`);
  }
  return lines.join('\n');
}
