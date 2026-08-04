import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { getGitFreshnessInfo } from './git.js';
import { sha256File, sha256Json, sha256Text } from './hash.js';
import { ensureWorkspaceDirs, getWorkspacePaths } from './paths.js';

export const CHECKPOINT_PHASES = [
  'discovery',
  'impact',
  'implementation',
  'verification',
  'review',
  'complete',
] as const;

export type CheckpointPhase = typeof CHECKPOINT_PHASES[number];
export type CheckpointAction = 'save' | 'load' | 'list' | 'complete';
export type ClaimStatus = 'fresh' | 'relocated' | 'stale' | 'missing' | 'ambiguous';

export interface EvidenceClaim {
  id?: string;
  claim: string;
  file: string;
  lines?: string;
  symbol?: string;
  confidence?: number;
  evidenceIds?: string[];
}

export interface CheckpointState {
  scopePlan?: Record<string, unknown>;
  requirements?: Array<Record<string, unknown>>;
  constraints?: string[];
  remainingWork?: string[];
  evidenceClaims?: EvidenceClaim[];
  decisions?: Array<Record<string, unknown>>;
  filesInspected?: string[];
  filesModified?: string[];
  latestTest?: {
    command?: string;
    exitCode?: number;
    summary?: string;
    outputTail?: string;
  };
  [key: string]: unknown;
}

export interface RepoState {
  headCommit: string;
  dirtyHash: string;
  capturedAt: string;
}

interface TaskRow {
  task_id: string;
  task_text: string;
  task_hash: string;
  status: 'active' | 'complete';
  latest_version: number;
  created_at: string;
  updated_at: string;
}

interface CheckpointRow {
  task_id: string;
  version: number;
  phase: CheckpointPhase;
  scope_plan_json: string | null;
  state_json: string;
  repo_state_json: string;
  created_at: string;
}

export interface SaveCheckpointInput {
  taskId?: string;
  expectedVersion?: number;
  task: string;
  phase: CheckpointPhase;
  state: CheckpointState;
}

export interface CheckpointRecord {
  taskId: string;
  version: number;
  task: string;
  status: 'active' | 'complete';
  phase: CheckpointPhase;
  state: CheckpointState;
  repoState: RepoState;
  createdAt: string;
}

export interface CheckpointLoadResult extends CheckpointRecord {
  resumeReady: boolean;
  claimValidation: Array<{
    id: string;
    file: string;
    status: ClaimStatus;
    fileHash?: string;
    storedFileHash?: string;
    sliceHash?: string;
    storedSliceHash?: string;
    reason?: string;
  }>;
  nextActions: Array<Record<string, unknown>>;
}

export class CheckpointConflictError extends Error {
  constructor(readonly taskId: string, readonly expectedVersion: number, readonly actualVersion: number) {
    super(`Checkpoint version conflict for ${taskId}: expected ${expectedVersion}, actual ${actualVersion}.`);
    this.name = 'CheckpointConflictError';
  }
}

export class CheckpointStateStore {
  private readonly db: DatabaseType;
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    const paths = getWorkspacePaths(this.root);
    ensureWorkspaceDirs(paths);
    this.db = new Database(paths.taskStatePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_runs (
        task_id TEXT PRIMARY KEY,
        task_text TEXT NOT NULL,
        task_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'complete')),
        latest_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_checkpoints (
        task_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('discovery', 'impact', 'implementation', 'verification', 'review', 'complete')),
        scope_plan_json TEXT,
        state_json TEXT NOT NULL,
        repo_state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (task_id, version),
        FOREIGN KEY (task_id) REFERENCES task_runs(task_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS task_checkpoints_created_idx ON task_checkpoints(created_at);
    `);
  }

  save(input: SaveCheckpointInput): CheckpointRecord {
    validatePhase(input.phase);
    const task = input.task.trim();
    if (!task) throw new Error('Checkpoint save requires a non-empty task.');
    const now = new Date().toISOString();
    const taskId = input.taskId?.trim() || crypto.randomUUID();
    const repoState = currentRepoState(this.root);
    const sanitizedState = sanitizeState(input.state);
    sanitizedState.evidenceClaims = bindCheckpointClaims(this.root, sanitizedState.evidenceClaims);
    const scopePlan = sanitizedState.scopePlan;

    const transaction = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM task_runs WHERE task_id = ?').get(taskId) as TaskRow | undefined;
      if (!existing) {
        if (input.expectedVersion !== undefined && input.expectedVersion !== 0) {
          throw new CheckpointConflictError(taskId, input.expectedVersion, 0);
        }
        this.db.prepare(`INSERT INTO task_runs(task_id, task_text, task_hash, status, latest_version, created_at, updated_at)
          VALUES (?, ?, ?, 'active', 0, ?, ?)`).run(taskId, task, sha256Text(task), now, now);
      } else {
        if (existing.status === 'complete') throw new Error(`Checkpoint task ${taskId} is complete and cannot be updated.`);
        if (input.expectedVersion === undefined) throw new Error(`Checkpoint update for ${taskId} requires expectedVersion.`);
        if (input.expectedVersion !== existing.latest_version) {
          throw new CheckpointConflictError(taskId, input.expectedVersion, existing.latest_version);
        }
        const latest = this.db.prepare('SELECT phase FROM task_checkpoints WHERE task_id = ? AND version = ?').get(taskId, existing.latest_version) as { phase: CheckpointPhase } | undefined;
        if (latest && !allowedPhaseTransition(latest.phase, input.phase)) {
          throw new Error(`Invalid checkpoint phase transition ${latest.phase} -> ${input.phase}.`);
        }
      }
      const current = this.db.prepare('SELECT latest_version FROM task_runs WHERE task_id = ?').get(taskId) as { latest_version: number };
      const version = current.latest_version + 1;
      this.db.prepare(`INSERT INTO task_checkpoints(task_id, version, phase, scope_plan_json, state_json, repo_state_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        taskId,
        version,
        input.phase,
        scopePlan ? JSON.stringify(scopePlan) : null,
        JSON.stringify(sanitizedState),
        JSON.stringify(repoState),
        now,
      );
      this.db.prepare("UPDATE task_runs SET latest_version = ?, status = ?, updated_at = ? WHERE task_id = ?")
        .run(version, input.phase === 'complete' ? 'complete' : 'active', now, taskId);
      return { taskId, version, now, repoState, sanitizedState };
    });

    const saved = transaction() as {
      taskId: string;
      version: number;
      now: string;
      repoState: RepoState;
      sanitizedState: CheckpointState;
    };
    return {
      taskId: saved.taskId,
      version: saved.version,
      task,
      status: input.phase === 'complete' ? 'complete' : 'active',
      phase: input.phase,
      state: saved.sanitizedState,
      repoState: saved.repoState,
      createdAt: saved.now,
    };
  }

  complete(taskId: string, expectedVersion: number, state: CheckpointState): CheckpointRecord {
    const existing = this.latest(taskId);
    if (!existing) throw new Error(`Unknown checkpoint taskId: ${taskId}`);
    const saved = this.save({ taskId, expectedVersion, task: existing.task, phase: 'complete', state });
    this.db.prepare("UPDATE task_runs SET status = 'complete', updated_at = ? WHERE task_id = ?").run(new Date().toISOString(), taskId);
    return { ...saved, status: 'complete' };
  }

  load(taskId: string, version?: number): CheckpointLoadResult {
    const row = (version === undefined
      ? this.db.prepare(`SELECT c.*, r.task_text, r.status FROM task_checkpoints c JOIN task_runs r ON r.task_id = c.task_id WHERE c.task_id = ? ORDER BY c.version DESC LIMIT 1`).get(taskId)
      : this.db.prepare(`SELECT c.*, r.task_text, r.status FROM task_checkpoints c JOIN task_runs r ON r.task_id = c.task_id WHERE c.task_id = ? AND c.version = ?`).get(taskId, version)) as (CheckpointRow & { task_text: string; status: 'active' | 'complete' }) | undefined;
    if (!row) throw new Error(`Checkpoint not found: ${taskId}${version === undefined ? '' : `@${version}`}`);
    const record: CheckpointRecord = rowToRecord(row);
    const current = currentRepoState(this.root);
    const claimValidation = validateClaims(this.root, record.state.evidenceClaims ?? []);
    const repoChanged = current.headCommit !== record.repoState.headCommit || current.dirtyHash !== record.repoState.dirtyHash;
    const unsafeClaims = claimValidation.some(claim => ['stale', 'missing', 'ambiguous'].includes(claim.status));
    const resumeReady = !repoChanged && !unsafeClaims;
    const nextActions: Array<Record<string, unknown>> = [];
    if (repoChanged) nextActions.push({ tool: 'codegraph_context', args: { task: record.task, resumeTaskId: record.taskId, freshEvidence: true }, reason: 'Repository HEAD or dirty state changed; refresh context before trusting checkpoint claims.' });
    for (const claim of claimValidation.filter(item => item.status !== 'fresh' && item.status !== 'relocated')) {
      nextActions.push({ tool: 'codegraph_slice', args: { file: claim.file }, reason: claim.reason ?? 'Revalidate this claim from current source.' });
    }
    return { ...record, resumeReady, claimValidation, nextActions: nextActions.slice(0, 8) };
  }

  list(limit = 20): Array<Pick<CheckpointRecord, 'taskId' | 'version' | 'task' | 'status' | 'phase' | 'createdAt'>> {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 100));
    const rows = this.db.prepare(`SELECT r.task_id, r.latest_version AS version, r.task_text, r.status, c.phase, c.created_at
      FROM task_runs r JOIN task_checkpoints c ON c.task_id = r.task_id AND c.version = r.latest_version
      ORDER BY r.updated_at DESC LIMIT ?`).all(bounded) as Array<{ task_id: string; version: number; task_text: string; status: 'active' | 'complete'; phase: CheckpointPhase; created_at: string }>;
    return rows.map(row => ({ taskId: row.task_id, version: row.version, task: row.task_text, status: row.status, phase: row.phase, createdAt: row.created_at }));
  }

  pruneCompleted(before: string, apply = false): { candidates: number; deleted: number } {
    const candidates = this.db.prepare("SELECT task_id FROM task_runs WHERE status = 'complete' AND updated_at < ?").all(before) as Array<{ task_id: string }>;
    if (!apply) return { candidates: candidates.length, deleted: 0 };
    const transaction = this.db.transaction(() => {
      for (const row of candidates) this.db.prepare('DELETE FROM task_runs WHERE task_id = ?').run(row.task_id);
    });
    transaction();
    return { candidates: candidates.length, deleted: candidates.length };
  }

  close(): void {
    this.db.close();
  }

  private latest(taskId: string): CheckpointRecord | undefined {
    const row = this.db.prepare(`SELECT c.*, r.task_text, r.status FROM task_checkpoints c JOIN task_runs r ON r.task_id = c.task_id WHERE c.task_id = ? ORDER BY c.version DESC LIMIT 1`).get(taskId) as (CheckpointRow & { task_text: string; status: 'active' | 'complete' }) | undefined;
    return row ? rowToRecord(row) : undefined;
  }
}

function validatePhase(phase: string): asserts phase is CheckpointPhase {
  if (!(CHECKPOINT_PHASES as readonly string[]).includes(phase)) throw new Error(`Invalid checkpoint phase: ${phase}.`);
}

function allowedPhaseTransition(from: CheckpointPhase, to: CheckpointPhase): boolean {
  if (from === to) return true;
  const transitions: Record<CheckpointPhase, readonly CheckpointPhase[]> = {
    discovery: ['impact', 'implementation'],
    impact: ['implementation'],
    implementation: ['verification'],
    verification: ['implementation', 'review', 'complete'],
    review: ['implementation', 'verification', 'complete'],
    complete: [],
  };
  return transitions[from].includes(to);
}

function rowToRecord(row: CheckpointRow & { task_text: string; status: 'active' | 'complete' }): CheckpointRecord {
  return {
    taskId: row.task_id,
    version: row.version,
    task: row.task_text,
    status: row.status,
    phase: row.phase,
    state: JSON.parse(row.state_json) as CheckpointState,
    repoState: JSON.parse(row.repo_state_json) as RepoState,
    createdAt: row.created_at,
  };
}

function currentRepoState(root: string): RepoState {
  const freshness = getGitFreshnessInfo(root);
  return {
    headCommit: freshness.headCommit ?? 'no-head',
    dirtyHash: freshness.dirtyHash,
    capturedAt: new Date().toISOString(),
  };
}

function sanitizeState(state: CheckpointState): CheckpointState {
  const copy = JSON.parse(JSON.stringify(state)) as CheckpointState;
  if (copy.latestTest?.outputTail) copy.latestTest.outputTail = redactAndTail(copy.latestTest.outputTail);
  if (Array.isArray(copy.evidenceClaims)) {
    copy.evidenceClaims = copy.evidenceClaims.slice(0, 100).map((claim, index) => ({
      ...claim,
      id: claim.id ?? `claim-${index + 1}`,
      claim: String(claim.claim ?? '').slice(0, 1000),
      file: String(claim.file ?? ''),
      lines: claim.lines?.slice(0, 80),
      symbol: claim.symbol?.slice(0, 240),
      evidenceIds: claim.evidenceIds?.slice(0, 20),
    }));
  }
  return copy;
}

function redactAndTail(value: string): string {
  return value
    .replace(/(api[_-]?key|token|password|secret)\s*[=:]\s*[^\s,;]+/gi, '$1=<redacted>')
    .slice(-4000);
}

function validateClaims(root: string, claims: EvidenceClaim[]): CheckpointLoadResult['claimValidation'] {
  return claims.map((claim, index) => {
    const id = claim.id ?? `claim-${index + 1}`;
    const file = normalizeClaimPath(root, claim.file);
    if (!file) return { id, file: claim.file, status: 'missing', reason: 'Claim path escapes the repository root or is empty.' };
    if (!fs.existsSync(file)) return { id, file: claim.file, status: 'missing', reason: 'Claim file no longer exists.' };
    const currentHash = sha256File(file);
    const storedHash = (claim as EvidenceClaim & { fileHash?: string }).fileHash;
    const sliceHash = sourceSliceHash(file, claim.lines);
    const storedSliceHash = (claim as EvidenceClaim & { sliceHash?: string }).sliceHash;
    if (storedHash && currentHash === storedHash) return { id, file: claim.file, status: 'fresh', fileHash: currentHash, storedFileHash: storedHash, sliceHash, storedSliceHash };
    if (storedSliceHash && sliceHash === storedSliceHash) return { id, file: claim.file, status: 'relocated', fileHash: currentHash, storedFileHash: storedHash, sliceHash, storedSliceHash, reason: 'The exact source slice is unchanged even though the file hash moved.' };
    const relocated = storedSliceHash ? findUniqueSliceMatch(file, storedSliceHash, claim.lines) : undefined;
    if (relocated) return { id, file: claim.file, status: 'relocated', fileHash: currentHash, storedFileHash: storedHash, sliceHash: relocated.hash, storedSliceHash, reason: `The source slice moved to lines ${relocated.lines}.` };
    if (!storedHash && !storedSliceHash) return { id, file: claim.file, status: 'ambiguous', fileHash: currentHash, reason: 'Checkpoint claim has no source binding hash.' };
    return { id, file: claim.file, status: 'stale', fileHash: currentHash, storedFileHash: storedHash, sliceHash, storedSliceHash, reason: 'Claim source changed since checkpoint.' };
  });
}

function normalizeClaimPath(root: string, value: string): string | undefined {
  const normalized = String(value ?? '').replace(/\\/g, '/').trim();
  if (!normalized || path.isAbsolute(normalized)) return undefined;
  const resolved = path.resolve(root, normalized);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return resolved;
}

function sourceSliceHash(file: string, lines?: string): string | undefined {
  if (!lines) return undefined;
  const match = lines.match(/^(\d+)(?:-(\d+))?$/);
  if (!match) return undefined;
  const start = Math.max(1, Number(match[1]));
  const end = Math.max(start, Number(match[2] ?? match[1]));
  const source = fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(start - 1, end).join('\n');
  return sha256Text(source);
}

function findUniqueSliceMatch(file: string, expectedHash: string, lines?: string): { lines: string; hash: string } | undefined {
  if (!lines) return undefined;
  const match = lines.match(/^(\d+)(?:-(\d+))?$/);
  if (!match) return undefined;
  const width = Math.max(1, Number(match[2] ?? match[1]) - Number(match[1]) + 1);
  const sourceLines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const hits: Array<{ lines: string; hash: string }> = [];
  for (let index = 0; index + width <= sourceLines.length; index++) {
    const text = sourceLines.slice(index, index + width).join('\n');
    const hash = sha256Text(text);
    if (hash === expectedHash) hits.push({ lines: `${index + 1}-${index + width}`, hash });
    if (hits.length > 1) return undefined;
  }
  return hits[0];
}

export function bindCheckpointClaims(root: string, claims: EvidenceClaim[] | undefined): EvidenceClaim[] | undefined {
  if (!claims) return undefined;
  return claims.map(claim => {
    const file = normalizeClaimPath(path.resolve(root), claim.file);
    if (!file || !fs.existsSync(file)) return claim;
    return {
      ...claim,
      id: claim.id ?? `claim-${sha256Json(claim).slice(0, 10)}`,
      fileHash: sha256File(file),
      sliceHash: sourceSliceHash(file, claim.lines),
    } as EvidenceClaim;
  });
}
