import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { V2Indexer } from '../../src/v2/index/indexer.js';
import { buildLocalArtifactIndex, localArtifactIndexPath } from '../../src/v2/mcp/local-artifact.js';
import { openCodeGraphDb, type CodeGraphDb } from '../../src/v2/storage/database.js';
import { inspectWorkspaceReadiness } from '../../src/v2/workspace-health.js';

const tempDirs: string[] = [];
const dbs: CodeGraphDb[] = [];

afterEach(async () => {
  for (const db of dbs.splice(0)) {
    await db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('workspace readiness diagnostics', () => {
  it('returns an actionable setup plan for a workspace with no index artifacts', () => {
    const repo = tempDir('codegraph-readiness-missing-');

    const readiness = inspectWorkspaceReadiness(repo);

    expect(readiness.ok).toBe(false);
    expect(readiness.state).toBe('missing');
    expect(readiness.database).toMatchObject({
      ok: false,
      state: 'missing',
      dbPath: path.join(repo, '.codegraph', 'graph.sqlite'),
    });
    expect(readiness.capabilities).toMatchObject({
      graphQueries: false,
      embeddedArtifact: false,
      facadeContext: false,
    });
    expect(readiness.nextActions[0]).toMatchObject({
      command: `codegraph setup --root "${repo}"`,
      reason: 'Build both the SQLite graph and embedded artifact index.',
    });
  });

  it('renders a human-readable status report by default', () => {
    const repo = tempDir('codegraph-status-human-');
    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'status',
      '--root',
      repo,
    ], { encoding: 'utf-8' });

    expect(output).toContain('CodeGraph Status');
    expect(output).toContain(`Root: ${repo}`);
    expect(output).toContain('State: missing');
    expect(output).toContain('Next actions');
    expect(output).toContain(`codegraph setup --root "${repo}"`);
  });

  it('supports machine-readable output for status', () => {
    const repo = tempDir('codegraph-status-json-');
    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'status',
      '--root',
      repo,
      '--json',
    ], { encoding: 'utf-8' });

    const report = JSON.parse(output) as { state?: string; ok?: boolean; nextActions?: Array<{ command?: string }> };
    expect(report.state).toBe('missing');
    expect(report.ok).toBe(false);
    expect(report.nextActions?.[0]?.command).toBe(`codegraph setup --root "${repo}"`);
  });

  it('fails with non-zero status when --require-ready blocks on incomplete workspaces', () => {
    const repo = tempDir('codegraph-status-require-ready-');

    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'status',
      '--root',
      repo,
      '--require-ready',
      '--json',
    ], { encoding: 'utf-8' })).toThrow();
  });

  it('fails when --require-fresh blocks stale indexed workspaces', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-status-require-fresh-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
}`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    const freshOutput = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'status',
      '--root',
      repo,
      '--json',
      '--require-fresh',
    ], { encoding: 'utf-8' });
    const freshReport = JSON.parse(freshOutput) as {
      gate?: { passed?: boolean; expected?: string };
      freshness?: { isStale?: boolean };
    };
    expect(freshReport.gate?.passed).toBe(true);
    expect(freshReport.gate?.expected).toBe('ready and fresh');
    expect(freshReport.freshness?.isStale).toBe(false);

    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}`);

    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'status',
      '--root',
      repo,
      '--json',
      '--require-fresh',
    ], { encoding: 'utf-8' })).toThrow();
  });

  it('returns a super-vip upgrade audit report with score and issues', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-upgrade-audit-pass-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}
`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    writeFile(repo, '.codegraph/logs/query.jsonl', JSON.stringify({
      ts: new Date().toISOString(),
      event: 'query',
      toolName: 'codegraph_status',
      routedToolName: 'codegraph_status',
      durationMs: 12,
      responseChars: 160,
      result: { ok: true, state: 'ready', capabilities: { graphQueries: true, freshGraph: true } },
    }) + '\n');

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--require-ready',
      '--min-score',
      '80',
    ], { encoding: 'utf-8' });

    const report = JSON.parse(output) as {
      score?: { overall?: number };
      gate?: { passed?: boolean; required?: boolean; expected?: string };
      queryLogSummary?: { queryEvents?: number };
      issues?: Array<{ id?: string }>;
      readiness?: { state?: string };
      grade?: string;
    };
    expect(report.readiness?.state).toBe('ready');
    expect(report.score?.overall).toBeGreaterThanOrEqual(80);
    expect(report.gate?.required).toBe(true);
    expect(report.gate?.passed).toBe(true);
    expect(report.queryLogSummary?.queryEvents).toBe(1);
    expect(report.issues?.find(issue => issue.id === 'readiness-ready')).toBeDefined();
    expect(report.grade).toBe('A+');
    expect(report.grade).toBeDefined();
  });

  it('renders super-vip upgrade audit in plain text with a grade', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-upgrade-audit-text-grade-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}
`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--tail',
      '5',
    ], { encoding: 'utf-8' });

    expect(output).toContain('CodeGraph Super VIP Audit');
    expect(output).toMatch(/Grade: (A\+|A|B\+|B|C|D|F)/);
  });

  it('fails upgrade audit when minimum score is not met', () => {
    const repo = tempDir('codegraph-upgrade-audit-score-fail-');
    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--min-score',
      '85',
    ], { encoding: 'utf-8' })).toThrow();
  });

  it('supports min-grade threshold and fails when not met', () => {
    const repo = tempDir('codegraph-upgrade-audit-grade-fail-');
    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--min-grade',
      'A+',
    ], { encoding: 'utf-8' })).toThrow();
  });

  it('supports min-grade threshold and reports in json', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-upgrade-audit-grade-pass-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    writeFile(repo, '.codegraph/logs/query.jsonl', JSON.stringify({
      ts: new Date().toISOString(),
      event: 'query',
      toolName: 'codegraph_status',
      routedToolName: 'codegraph_status',
      durationMs: 12,
      responseChars: 160,
      result: { ok: true, state: 'ready', capabilities: { graphQueries: true, freshGraph: true } },
    }) + '\n');

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--min-grade',
      'B',
    ], { encoding: 'utf-8' });
    const report = JSON.parse(output) as {
      grade?: string;
      gate?: { required?: boolean; passed?: boolean; reasons?: string[] };
    };
    expect(report.gate?.required).toBe(true);
    expect(report.gate?.passed).toBe(true);
    expect(report.gate?.reasons).toBeUndefined();
    expect((report.grade === 'A+' || report.grade === 'A' || report.grade === 'B+' || report.grade === 'B' || report.grade === 'C' || report.grade === 'D' || report.grade === 'F')).toBe(true);
  });

  it('supports min-grade from environment variable', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-upgrade-audit-env-grade-pass-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
    ], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CODEGRAPH_UPGRADE_AUDIT_MIN_GRADE: 'B',
      },
    });
    const report = JSON.parse(output) as {
      gate?: { required?: boolean; passed?: boolean };
      grade?: string;
    };
    expect(report.gate?.required).toBe(true);
    expect(report.gate?.passed).toBe(true);
    expect(['A+', 'A', 'B+', 'B', 'C', 'D', 'F']).toContain(report.grade);
  });

  it('supports max-slow-ms threshold and fails when exceeded', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-upgrade-audit-max-slow-ms-fail-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
        durationMs: 3000,
        responseChars: 500,
        result: { ok: true, capabilities: { graphQueries: true, freshGraph: true } },
      }) + '\n',
    ].join(''));

    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--require-ready',
      '--max-slow-ms',
      '2000',
    ], { encoding: 'utf-8' })).toThrow();
  });

  it('supports max-slow-ms threshold from environment variable', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-upgrade-audit-max-slow-ms-pass-env-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
        durationMs: 3000,
        responseChars: 500,
        result: { ok: true, capabilities: { graphQueries: true, freshGraph: true } },
      }) + '\n',
    ].join(''));

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--require-ready',
    ], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CODEGRAPH_UPGRADE_AUDIT_MAX_SLOW_MS: '5000',
      },
    });
    const report = JSON.parse(output) as {
      gate?: { required?: boolean; passed?: boolean; expected?: string };
      queryLogSummary?: { durationMs?: { max?: number } };
    };
    expect(report.gate?.required).toBe(true);
    expect(report.gate?.passed).toBe(true);
    expect(report.queryLogSummary?.durationMs?.max).toBe(3000);
  });

  it('supports max-slow-ms-p95 threshold and fails when p95 is exceeded', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-upgrade-audit-max-slow-ms-p95-fail-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    const fastQueryLines = Array.from({ length: 19 }, () => JSON.stringify({
      ts: new Date().toISOString(),
      event: 'query',
      toolName: 'codegraph_context',
      routedToolName: 'get_change_pack',
      durationMs: 300,
      responseChars: 500,
      result: { ok: true, capabilities: { graphQueries: true, freshGraph: true } },
    }) + '\n');
    fastQueryLines.push(JSON.stringify({
      ts: new Date().toISOString(),
      event: 'query',
      toolName: 'codegraph_context',
      routedToolName: 'get_change_pack',
      durationMs: 5000,
      responseChars: 500,
      result: { ok: true, capabilities: { graphQueries: true, freshGraph: true } },
    }) + '\n');

    writeFile(repo, '.codegraph/logs/query.jsonl', fastQueryLines.join(''));

    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--require-ready',
      '--max-slow-ms',
      '7000',
      '--max-slow-ms-p95',
      '250',
    ], { encoding: 'utf-8' })).toThrow();
  });

  it('supports max-slow-ms-p95 threshold from environment variable', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-upgrade-audit-max-slow-ms-p95-pass-env-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    const fastQueryLines = Array.from({ length: 19 }, () => JSON.stringify({
      ts: new Date().toISOString(),
      event: 'query',
      toolName: 'codegraph_context',
      routedToolName: 'get_change_pack',
      durationMs: 300,
      responseChars: 500,
      result: { ok: true, capabilities: { graphQueries: true, freshGraph: true } },
    }) + '\n');
    fastQueryLines.push(JSON.stringify({
      ts: new Date().toISOString(),
      event: 'query',
      toolName: 'codegraph_context',
      routedToolName: 'get_change_pack',
      durationMs: 5000,
      responseChars: 500,
      result: { ok: true, capabilities: { graphQueries: true, freshGraph: true } },
    }) + '\n');

    writeFile(repo, '.codegraph/logs/query.jsonl', fastQueryLines.join(''));

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--require-ready',
      '--max-slow-ms',
      '7000',
    ], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CODEGRAPH_UPGRADE_AUDIT_MAX_SLOW_MS: '7000',
        CODEGRAPH_UPGRADE_AUDIT_MAX_SLOW_MS_P95: '350',
      },
    });
    const report = JSON.parse(output) as {
      gate?: { required?: boolean; passed?: boolean; expected?: string };
      queryLogSummary?: { durationMs?: { max?: number; p95?: number } };
    };
    expect(report.gate?.required).toBe(true);
    expect(report.gate?.passed).toBe(true);
    expect(report.gate?.actual).toContain('p95QueryMs=');
    expect(report.queryLogSummary?.durationMs?.p95).toBe(300);
  });

  it('supports max-invalid-lines threshold and fails when exceeded', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-upgrade-audit-max-invalid-lines-fail-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
        durationMs: 300,
        responseChars: 500,
        result: { ok: true, capabilities: { graphQueries: true, freshGraph: true } },
      }) + '\n',
      'invalid-json-line',
    ].join(''));

    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--require-ready',
      '--max-invalid-lines',
      '0',
    ], { encoding: 'utf-8' })).toThrow();
  });

  it('supports max-invalid-lines threshold from environment variable', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-upgrade-audit-max-invalid-lines-pass-env-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
        durationMs: 300,
        responseChars: 500,
        result: { ok: true, capabilities: { graphQueries: true, freshGraph: true } },
      }) + '\n',
      'invalid-json-line',
    ].join(''));

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--require-ready',
    ], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CODEGRAPH_UPGRADE_AUDIT_MAX_INVALID_LINES: '1',
      },
    });
    const report = JSON.parse(output) as {
      gate?: { required?: boolean; passed?: boolean; expected?: string };
      queryLogSummary?: { invalidLines?: number };
    };
    expect(report.gate?.required).toBe(true);
    expect(report.gate?.passed).toBe(true);
    expect(report.queryLogSummary?.invalidLines).toBe(1);
  });

  it('supports max-invalid-lines with command-line flag', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-upgrade-audit-max-invalid-lines-pass-flag-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
        durationMs: 300,
        responseChars: 500,
        result: { ok: true, capabilities: { graphQueries: true, freshGraph: true } },
      }) + '\n',
      'invalid-json-line',
    ].join(''));

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--require-ready',
      '--max-invalid-lines',
      '1',
    ], { encoding: 'utf-8' });
    const report = JSON.parse(output) as {
      gate?: { required?: boolean; passed?: boolean; expected?: string };
      queryLogSummary?: { invalidLines?: number };
    };
    expect(report.gate?.required).toBe(true);
    expect(report.gate?.passed).toBe(true);
    expect(report.queryLogSummary?.invalidLines).toBe(1);
  });

  it('supports max-stale-queries threshold and fails when exceeded', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-upgrade-audit-max-stale-queries-fail-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
        durationMs: 120,
        responseChars: 500,
        result: { indexFreshness: { isStale: true } },
      }) + '\n',
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'search_symbol',
        durationMs: 130,
        responseChars: 100,
        result: { indexFreshness: { isStale: true } },
      }) + '\n',
    ].join(''));

    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--require-ready',
      '--max-stale-queries',
      '1',
    ], { encoding: 'utf-8' })).toThrow();
  });

  it('supports max-stale-queries from environment variable', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-upgrade-audit-max-stale-queries-pass-env-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
        durationMs: 120,
        responseChars: 500,
        result: { indexFreshness: { isStale: true } },
      }) + '\n',
    ].join(''));

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--require-ready',
    ], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CODEGRAPH_UPGRADE_AUDIT_MAX_STALE_QUERIES: '1',
      },
    });
    const report = JSON.parse(output) as {
      gate?: { required?: boolean; passed?: boolean; expected?: string };
      queryLogSummary?: { staleQueries?: number };
    };
    expect(report.gate?.required).toBe(true);
    expect(report.gate?.passed).toBe(true);
    expect(report.queryLogSummary?.staleQueries).toBe(1);
  });

  it('supports max-degraded-queries threshold and fails when exceeded', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-upgrade-audit-max-degraded-queries-fail-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
        durationMs: 120,
        responseChars: 500,
        result: { degraded: true },
      }) + '\n',
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'search_symbol',
        durationMs: 130,
        responseChars: 100,
        result: { degraded: true },
      }) + '\n',
    ].join(''));

    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--require-ready',
      '--max-degraded-queries',
      '1',
    ], { encoding: 'utf-8' })).toThrow();
  });

  it('supports max-degraded-queries with environment variable', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-upgrade-audit-max-degraded-queries-pass-env-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
        durationMs: 120,
        responseChars: 500,
        result: { degraded: true },
      }) + '\n',
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'search_symbol',
        durationMs: 130,
        responseChars: 100,
        result: { degraded: false },
      }) + '\n',
    ].join(''));

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--require-ready',
    ], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CODEGRAPH_UPGRADE_AUDIT_MAX_DEGRADED_QUERIES: '1',
      },
    });
    const report = JSON.parse(output) as {
      gate?: { required?: boolean; passed?: boolean; expected?: string };
      queryLogSummary?: { degradedQueries?: number };
    };
    expect(report.gate?.required).toBe(true);
    expect(report.gate?.passed).toBe(true);
    expect(report.queryLogSummary?.degradedQueries).toBe(1);
  });

  it('supports max-stale-ratio threshold and fails when exceeded', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-upgrade-audit-max-stale-ratio-fail-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
        durationMs: 120,
        responseChars: 500,
        result: { indexFreshness: { isStale: true } },
      }) + '\n',
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'search_symbol',
        durationMs: 130,
        responseChars: 100,
        result: { indexFreshness: { isStale: true } },
      }) + '\n',
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'search_symbol',
        durationMs: 110,
        responseChars: 120,
        result: { ok: true },
      }) + '\n',
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'search_symbol',
        durationMs: 115,
        responseChars: 90,
        result: { ok: true },
      }) + '\n',
    ].join(''));

    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--require-ready',
      '--max-stale-ratio',
      '49',
    ], { encoding: 'utf-8' })).toThrow();
  });

  it('supports max-stale-ratio from environment variable', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-upgrade-audit-max-stale-ratio-pass-env-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
        durationMs: 120,
        responseChars: 500,
        result: { indexFreshness: { isStale: true } },
      }) + '\n',
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'search_symbol',
        durationMs: 130,
        responseChars: 100,
        result: { indexFreshness: { isStale: false } },
      }) + '\n',
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'search_symbol',
        durationMs: 110,
        responseChars: 120,
        result: { ok: true },
      }) + '\n',
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'search_symbol',
        durationMs: 115,
        responseChars: 90,
        result: { ok: true },
      }) + '\n',
    ].join(''));

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--require-ready',
    ], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CODEGRAPH_UPGRADE_AUDIT_MAX_STALE_RATIO: '50',
      },
    });
    const report = JSON.parse(output) as {
      gate?: { required?: boolean; passed?: boolean; expected?: string };
      queryLogSummary?: { staleQueries?: number };
    };
    expect(report.gate?.required).toBe(true);
    expect(report.gate?.passed).toBe(true);
    expect(report.queryLogSummary?.staleQueries).toBe(1);
  });

  it('supports max-degraded-ratio threshold and fails when exceeded', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-upgrade-audit-max-degraded-ratio-fail-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
        durationMs: 120,
        responseChars: 500,
        result: { degraded: true },
      }) + '\n',
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'search_symbol',
        durationMs: 130,
        responseChars: 100,
        result: { degraded: true },
      }) + '\n',
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'search_symbol',
        durationMs: 110,
        responseChars: 120,
        result: { degraded: true },
      }) + '\n',
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'search_symbol',
        durationMs: 115,
        responseChars: 90,
        result: { degraded: false },
      }) + '\n',
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'search_symbol',
        durationMs: 125,
        responseChars: 90,
        result: { degraded: false },
      }) + '\n',
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'search_symbol',
        durationMs: 130,
        responseChars: 90,
        result: { degraded: false },
      }) + '\n',
    ].join(''));

    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--require-ready',
      '--max-degraded-ratio',
      '30',
    ], { encoding: 'utf-8' })).toThrow();
  });

  it('supports max-degraded-ratio with environment variable', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-upgrade-audit-max-degraded-ratio-pass-env-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
        durationMs: 120,
        responseChars: 500,
        result: { degraded: true },
      }) + '\n',
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'search_symbol',
        durationMs: 130,
        responseChars: 100,
        result: { degraded: true },
      }) + '\n',
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'search_symbol',
        durationMs: 110,
        responseChars: 120,
        result: { degraded: false },
      }) + '\n',
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'search_symbol',
        durationMs: 115,
        responseChars: 90,
        result: { degraded: false },
      }) + '\n',
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'search_symbol',
        durationMs: 125,
        responseChars: 90,
        result: { degraded: false },
      }) + '\n',
    ].join(''));

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--require-ready',
    ], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CODEGRAPH_UPGRADE_AUDIT_MAX_DEGRADED_RATIO: '50',
      },
    });
    const report = JSON.parse(output) as {
      gate?: { required?: boolean; passed?: boolean; expected?: string };
      queryLogSummary?: { degradedQueries?: number };
    };
    expect(report.gate?.required).toBe(true);
    expect(report.gate?.passed).toBe(true);
    expect(report.queryLogSummary?.degradedQueries).toBe(2);
  });

  it('rejects invalid max-slow-ms value', () => {
    const repo = tempDir('codegraph-upgrade-audit-invalid-max-slow-ms-');
    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--max-slow-ms',
      'ZZ',
    ], { encoding: 'utf-8' })).toThrow(/Invalid --max-slow-ms value: ZZ/);
  });

  it('rejects invalid max-slow-ms-p95 value', () => {
    const repo = tempDir('codegraph-upgrade-audit-invalid-max-slow-ms-p95-');
    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--max-slow-ms-p95',
      'ZZ',
    ], { encoding: 'utf-8' })).toThrow(/Invalid --max-slow-ms-p95 value: ZZ/);
  });

  it('rejects invalid max-invalid-lines value', () => {
    const repo = tempDir('codegraph-upgrade-audit-invalid-max-invalid-lines-');
    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--max-invalid-lines',
      'ZZ',
    ], { encoding: 'utf-8' })).toThrow(/Invalid --max-invalid-lines value: ZZ/);
  });

  it('rejects invalid max-stale-queries value', () => {
    const repo = tempDir('codegraph-upgrade-audit-invalid-max-stale-queries-');
    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--max-stale-queries',
      'ZZ',
    ], { encoding: 'utf-8' })).toThrow(/Invalid --max-stale-queries value: ZZ/);
  });

  it('rejects invalid max-degraded-queries value', () => {
    const repo = tempDir('codegraph-upgrade-audit-invalid-max-degraded-queries-');
    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--max-degraded-queries',
      'ZZ',
    ], { encoding: 'utf-8' })).toThrow(/Invalid --max-degraded-queries value: ZZ/);
  });

  it('rejects invalid max-stale-ratio value', () => {
    const repo = tempDir('codegraph-upgrade-audit-invalid-max-stale-ratio-');
    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--max-stale-ratio',
      'ZZ',
    ], { encoding: 'utf-8' })).toThrow(/Invalid --max-stale-ratio value: ZZ/);
  });

  it('rejects out-of-range max-degraded-ratio value', () => {
    const repo = tempDir('codegraph-upgrade-audit-invalid-max-degraded-ratio-');
    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--max-degraded-ratio',
      '101',
    ], { encoding: 'utf-8' })).toThrow(/Use a number from 0 to 100/);
  });

  it('supports upgrade-audit policy file with threshold overrides', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-upgrade-audit-policy-fail-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    fs.mkdirSync(path.join(repo, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.codegraph', 'upgrade-audit.json'), JSON.stringify({
      'min-score': 99,
    }));

    let rawOutput = '';
    try {
      execFileSync(process.execPath, [
        path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
        'src/cli.ts',
        'upgrade-audit',
        '--root',
        repo,
        '--json',
      ], { encoding: 'utf-8' });
      expect.unreachable('Expected upgrade-audit with strict policy to fail');
    } catch (error) {
      rawOutput = (error as { stdout?: string }).stdout?.toString() ?? '';
    }

    const report = JSON.parse(rawOutput) as {
      gate?: { required?: boolean; passed?: boolean; expected?: string };
      score?: { overall?: number };
    };
    expect(report.gate?.required).toBe(true);
    expect(report.gate?.passed).toBe(false);
    expect(report.gate?.expected).toContain('score >= 99');
    expect(report.score?.overall).toBeLessThan(99);
  });

  it('supports overriding policy with explicit CLI values', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-upgrade-audit-policy-override-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    const policyPath = path.join(repo, '.codegraph', 'upgrade-audit.json');
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(policyPath, JSON.stringify({
      'min-score': 99,
    }));

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--policy',
      policyPath,
      '--min-score',
      '95',
    ], { encoding: 'utf-8' });
    const report = JSON.parse(output) as {
      gate?: { required?: boolean; passed?: boolean; expected?: string };
      score?: { overall?: number };
    };
    expect(report.gate?.required).toBe(true);
    expect(report.gate?.passed).toBe(true);
    expect(report.gate?.expected).toContain('score >= 95');
    expect(report.score?.overall).toBeLessThan(99);
  });

  it('accepts camelCase upgrade-audit policy keys', () => {
    const repo = tempDir('codegraph-upgrade-audit-policy-camelcase-');
    fs.mkdirSync(path.join(repo, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.codegraph', 'upgrade-audit.json'), JSON.stringify({
      minScore: 1,
    }));

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
    ], { encoding: 'utf-8' });
    const report = JSON.parse(output) as {
      gate?: { required?: boolean; passed?: boolean; expected?: string };
      score?: { overall?: number };
    };
    expect(report.gate?.required).toBe(true);
    expect(report.gate?.passed).toBe(true);
    expect(report.gate?.expected).toContain('score >= 1');
    expect((report.score?.overall ?? 0)).toBeGreaterThan(0);
  });

  it('rejects unknown keys in upgrade-audit policy files', () => {
    const repo = tempDir('codegraph-upgrade-audit-policy-unknown-key-');
    fs.mkdirSync(path.join(repo, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.codegraph', 'upgrade-audit.json'), JSON.stringify({
      unknown: 1,
    }));

    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
    ], { encoding: 'utf-8' })).toThrow(/Invalid upgrade-audit policy file: .*Unknown key: unknown\./);
  });

  it('rejects non-numeric policy values', () => {
    const repo = tempDir('codegraph-upgrade-audit-policy-non-numeric-');
    fs.mkdirSync(path.join(repo, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.codegraph', 'upgrade-audit.json'), JSON.stringify({
      'max-slow-ms': 'too-many',
    }));

    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
    ], { encoding: 'utf-8' })).toThrow(/Invalid upgrade-audit policy file: .*max-slow-ms must be an integer from 1 to Infinity\./);
  });

  it('rejects out-of-range policy values', () => {
    const repo = tempDir('codegraph-upgrade-audit-policy-out-of-range-');
    fs.mkdirSync(path.join(repo, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.codegraph', 'upgrade-audit.json'), JSON.stringify({
      'max-stale-ratio': 120,
    }));

    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
    ], { encoding: 'utf-8' })).toThrow(/Invalid upgrade-audit policy file: .*max-stale-ratio must be a number from 0 to 100\./);
  });

  it('rejects invalid upgrade-audit policy files', () => {
    const repo = tempDir('codegraph-upgrade-audit-policy-invalid-json-');
    fs.mkdirSync(path.join(repo, '.codegraph'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.codegraph', 'upgrade-audit.json'), '{not valid json');

    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
    ], { encoding: 'utf-8' })).toThrow(/Invalid upgrade-audit policy file/);
  });

  it('reports absolute policy path when missing', () => {
    const repo = tempDir('codegraph-upgrade-audit-policy-absolute-missing-');
    const absolutePolicyPath = path.join(repo, 'policy', 'missing-upgrade-audit.json');
    let rawError = '';

    try {
      execFileSync(process.execPath, [
        path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
        'src/cli.ts',
        'upgrade-audit',
        '--root',
        repo,
        '--json',
        '--policy',
        absolutePolicyPath,
      ], { encoding: 'utf-8' });
      expect.unreachable('Expected upgrade-audit with missing policy path to fail');
    } catch (caught) {
      const error = caught as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
      rawError = error.message ?? '';
      rawError += (typeof error.stderr === 'string' ? error.stderr : error.stderr ? error.stderr.toString() : '');
      rawError += (typeof error.stdout === 'string' ? error.stdout : error.stdout ? error.stdout.toString() : '');
    }

    expect(rawError).toContain(`Upgrade audit policy file not found: ${absolutePolicyPath}`);
  });

  it('supports min-score from environment variable', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-upgrade-audit-env-score-pass-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
    ], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CODEGRAPH_UPGRADE_AUDIT_MIN_SCORE: '70',
      },
    });
    const report = JSON.parse(output) as {
      gate?: { required?: boolean; passed?: boolean };
      score?: { overall?: number };
    };
    expect(report.score?.overall).toBeGreaterThanOrEqual(70);
    expect(report.gate?.required).toBe(true);
    expect(report.gate?.passed).toBe(true);
  });

  it('rejects invalid min-grade value', () => {
    const repo = tempDir('codegraph-upgrade-audit-invalid-grade-');
    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
      '--min-grade',
      'ZZ',
    ], { encoding: 'utf-8' })).toThrow();
  });

  it('rejects invalid min-grade environment variable', () => {
    const repo = tempDir('codegraph-upgrade-audit-env-invalid-grade-');
    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'upgrade-audit',
      '--root',
      repo,
      '--json',
    ], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        CODEGRAPH_UPGRADE_AUDIT_MIN_GRADE: 'ZZ',
      },
    })).toThrow(/Invalid CODEGRAPH_UPGRADE_AUDIT_MIN_GRADE value: ZZ/);
  });

  it('logs MCP status readiness checks', async () => {
    const repo = tempDir('codegraph-readiness-mcp-status-log-');
    const client = new Client({ name: 'codegraph-status-log-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
        'src/cli.ts',
        'mcp',
        '--root',
        repo,
        '--mcp-profile',
        'client',
        '--no-prewarm',
      ],
    });

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'codegraph_status',
        arguments: {},
      });
      const parsed = JSON.parse(firstMcpText(result)) as {
        ok?: boolean;
        state?: string;
        capabilities?: { graphQueries?: boolean };
      };

      expect(parsed.ok).toBe(false);
      expect(parsed.state).toBe('unindexed');
      expect(parsed.capabilities?.graphQueries).toBe(false);

      const logLines = fs.readFileSync(path.join(repo, '.codegraph', 'logs', 'query.jsonl'), 'utf-8')
        .trim()
        .split(/\r?\n/);
      const logEntry = JSON.parse(logLines.at(-1) ?? '{}') as {
        event?: string;
        toolName?: string;
        result?: {
          ok?: boolean;
          state?: string;
          capabilities?: { graphQueries?: boolean };
        };
      };
      expect(logEntry.event).toBe('query');
      expect(logEntry.toolName).toBe('codegraph_status');
      expect(logEntry.result).toMatchObject({
        ok: false,
        state: 'unindexed',
        capabilities: { graphQueries: false },
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it('summarizes query logs for quick MCP runtime audits', () => {
    const repo = tempDir('codegraph-readiness-log-summary-');
    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: '2026-06-22T00:00:00.000Z',
        event: 'query',
        toolName: 'codegraph_status',
        routedToolName: 'codegraph_status',
        durationMs: 12,
        responseChars: 400,
        result: {
          ok: false,
          state: 'unindexed',
          capabilities: { graphQueries: false },
        },
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:01.000Z',
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
        durationMs: 1200,
        responseChars: 27000,
        result: {
          answerable: true,
          indexFreshness: { isStale: true },
          debugTiming: { totalMs: 1100, topPhase: { name: 'context_packet', durationMs: 700 } },
        },
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:02.000Z',
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_research_pack',
        durationMs: 320,
        responseChars: 9000,
        result: {
          degraded: true,
          source: 'local_filesystem_fallback',
        },
        fallbackReason: { code: 'workspace_not_indexed' },
      }),
    ].join('\n'));

    const summary = JSON.parse(execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'logs',
      '--root',
      repo,
      '--summary',
    ], { encoding: 'utf-8' })) as {
      totalEvents?: number;
      staleQueries?: number;
      degradedQueries?: number;
      debugTimedQueries?: number;
      fallbackQueries?: number;
      tools?: Record<string, { count?: number; degraded?: number; stale?: number }>;
      slowest?: Array<{ toolName?: string; routedToolName?: string; durationMs?: number }>;
    };

    expect(summary.totalEvents).toBe(3);
    expect(summary.staleQueries).toBe(1);
    expect(summary.degradedQueries).toBe(1);
    expect(summary.debugTimedQueries).toBe(1);
    expect(summary.fallbackQueries).toBe(1);
    expect(summary.tools?.codegraph_context).toMatchObject({
      count: 2,
      degraded: 1,
      stale: 1,
    });
    expect(summary.slowest?.[0]).toMatchObject({
      toolName: 'codegraph_context',
      routedToolName: 'get_change_pack',
      durationMs: 1200,
    });
  });

  it('summarizes query logs with --since filter', () => {
    const repo = tempDir('codegraph-readiness-log-summary-since-');
    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: '2026-06-22T00:00:00.000Z',
        event: 'query',
        toolName: 'codegraph_status',
        routedToolName: 'codegraph_status',
        durationMs: 10,
        responseChars: 100,
        result: {
          ok: false,
          state: 'unindexed',
        },
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:01.500Z',
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
        durationMs: 1200,
        responseChars: 150,
        result: {
          answerable: false,
          indexFreshness: { isStale: true },
        },
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:02.000Z',
        event: 'query',
        toolName: 'search_symbol',
        routedToolName: 'search_symbol',
        durationMs: 400,
        responseChars: 80,
        result: {
          answerable: false,
        },
      }),
    ].join('\n'));

    const summary = JSON.parse(execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'logs',
      '--root',
      repo,
      '--summary',
      '--since',
      '2026-06-22T00:00:01Z',
    ], { encoding: 'utf-8' })) as {
      totalEvents?: number;
      queryEvents?: number;
      staleQueries?: number;
      tools?: Record<string, { count?: number }>;
      filters?: { since?: string };
    };

    expect(summary.filters).toMatchObject({
      since: '2026-06-22T00:00:01.000Z',
    });
    expect(summary.totalEvents).toBe(2);
    expect(summary.queryEvents).toBe(2);
    expect(summary.staleQueries).toBe(1);
    expect(summary.tools?.codegraph_context).toMatchObject({
      count: 1,
    });
    expect(summary.tools?.search_symbol).toMatchObject({
      count: 1,
    });
  });

  it('filters log summaries by tool name', () => {
    const repo = tempDir('codegraph-readiness-log-summary-tool-');
    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: '2026-06-22T00:00:00.000Z',
        event: 'query',
        toolName: 'codegraph_status',
        routedToolName: 'codegraph_status',
        durationMs: 10,
        responseChars: 100,
        result: {
          ok: false,
          state: 'unindexed',
        },
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:01.000Z',
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
        durationMs: 1200,
        responseChars: 150,
        result: {
          answerable: false,
          indexFreshness: { isStale: true },
        },
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:02.000Z',
        event: 'query',
        toolName: 'search_symbol',
        routedToolName: 'search_symbol',
        durationMs: 400,
        responseChars: 80,
        result: {
          answerable: false,
        },
      }),
    ].join('\n'));

    const summary = JSON.parse(execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'logs',
      '--root',
      repo,
      '--summary',
      '--tool',
      'codegraph_context',
    ], { encoding: 'utf-8' })) as {
      queryEvents?: number;
      totalEvents?: number;
      tools?: Record<string, { count?: number }>;
      filters?: { tool?: string };
    };

    expect(summary.totalEvents).toBe(1);
    expect(summary.queryEvents).toBe(1);
    expect(summary.filters).toMatchObject({
      tool: 'codegraph_context',
    });
    expect(summary.tools).toEqual({
      codegraph_context: {
        count: 1,
        stale: 1,
        degraded: 0,
        debugTimed: 0,
        fallback: 0,
        avgMs: 1200,
        maxMs: 1200,
      },
    });
  });

  it('filters raw logs by event name', () => {
    const repo = tempDir('codegraph-readiness-log-raw-event-');
    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: '2026-06-22T00:00:00.000Z',
        event: 'query',
        toolName: 'codegraph_status',
        routedToolName: 'codegraph_status',
        durationMs: 10,
        responseChars: 100,
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:01.000Z',
        event: 'watch',
        toolName: 'codegraph_health',
        routedToolName: 'codegraph_health',
        durationMs: 5,
        responseChars: 120,
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:02.000Z',
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'review_patch',
        durationMs: 400,
        responseChars: 200,
      }),
    ].join('\n'));

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'logs',
      '--root',
      repo,
      '--event',
      'watch',
    ], { encoding: 'utf-8' });

    const lines = output.trim().split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '{}') as { event?: string };
    expect(parsed.event).toBe('watch');
  });

  it('filters raw logs by time window even without event/tool filters', () => {
    const repo = tempDir('codegraph-readiness-log-raw-time-window-');
    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: '2026-06-22T00:00:00.000Z',
        event: 'query',
        toolName: 'codegraph_status',
        routedToolName: 'codegraph_status',
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:01.500Z',
        event: 'watch',
        toolName: 'codegraph_health',
        routedToolName: 'codegraph_health',
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:02.000Z',
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
      }),
    ].join('\n'));

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'logs',
      '--root',
      repo,
      '--since',
      '2026-06-22T00:00:01Z',
      '--until',
      '2026-06-22T00:00:02Z',
    ], { encoding: 'utf-8' });

    const lines = output.trim().split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      ts: '2026-06-22T00:00:01.500Z',
    });
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({
      ts: '2026-06-22T00:00:02.000Z',
    });
  });

  it('filters raw logs by event and upper time bound', () => {
    const repo = tempDir('codegraph-readiness-log-raw-until-');
    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: '2026-06-22T00:00:00.000Z',
        event: 'query',
        toolName: 'codegraph_status',
        routedToolName: 'codegraph_status',
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:01.000Z',
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:02.000Z',
        event: 'query',
        toolName: 'search_symbol',
        routedToolName: 'search_symbol',
      }),
    ].join('\n'));

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'logs',
      '--root',
      repo,
      '--event',
      'query',
      '--until',
      '2026-06-22T00:00:01.500Z',
    ], { encoding: 'utf-8' });

    const lines = output.trim().split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it('reads full log history with --all for deep audits', () => {
    const repo = tempDir('codegraph-readiness-log-raw-all-');
    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: '2026-06-22T00:00:00.000Z',
        event: 'query',
        toolName: 'codegraph_status',
        routedToolName: 'codegraph_status',
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:01.000Z',
        event: 'query',
        toolName: 'codegraph_status',
        routedToolName: 'codegraph_status',
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:02.000Z',
        event: 'watch',
        toolName: 'codegraph_health',
        routedToolName: 'codegraph_health',
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:03.000Z',
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
      }),
    ].join('\n'));

    const defaultTailOutput = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'logs',
      '--root',
      repo,
      '--tail',
      '2',
      '--event',
      'query',
    ], { encoding: 'utf-8' });

    const allOutput = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'logs',
      '--root',
      repo,
      '--tail',
      '2',
      '--all',
      '--event',
      'query',
    ], { encoding: 'utf-8' });

    expect(defaultTailOutput.trim().split(/\r?\n/).filter(Boolean)).toHaveLength(1);
    expect(defaultTailOutput).toContain('2026-06-22T00:00:03.000Z');
    expect(allOutput.trim().split(/\r?\n/).filter(Boolean)).toHaveLength(3);
    expect(allOutput).toContain('2026-06-22T00:00:00.000Z');
    expect(allOutput).toContain('2026-06-22T00:00:01.000Z');
    expect(allOutput).toContain('2026-06-22T00:00:03.000Z');
  });

  it('includes invalid log lines with --invalid', () => {
    const repo = tempDir('codegraph-readiness-log-invalid-lines-');
    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: '2026-06-22T00:00:00.000Z',
        event: 'query',
        toolName: 'codegraph_status',
        routedToolName: 'codegraph_status',
      }),
      '{not valid json',
      JSON.stringify({
        ts: '2026-06-22T00:00:01.000Z',
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
      }),
    ].join('\n'));

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'logs',
      '--root',
      repo,
      '--invalid',
      '--event',
      'query',
    ], { encoding: 'utf-8' });

    const lines = output.trim().split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ event: 'query', toolName: 'codegraph_status' });
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({
      invalidLine: true,
      rawLine: 2,
    });
    expect(JSON.parse(lines[2] ?? '{}')).toMatchObject({ event: 'query', toolName: 'codegraph_context' });
  });

  it('keeps default raw output unchanged when logs contain malformed rows', () => {
    const repo = tempDir('codegraph-readiness-log-invalid-rows-default-');
    writeFile(repo, '.codegraph/logs/query.jsonl', [
      '{not valid json',
      JSON.stringify({
        ts: '2026-06-22T00:00:00.000Z',
        event: 'query',
        toolName: 'codegraph_status',
        routedToolName: 'codegraph_status',
      }),
    ].join('\n'));

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'logs',
      '--root',
      repo,
    ], { encoding: 'utf-8' });

    const lines = output.trim().split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('{not valid json');
    expect(lines[1]).toContain('codegraph_status');
  });

  it('adds invalid line samples in summary when --invalid is used', () => {
    const repo = tempDir('codegraph-readiness-log-summary-invalid-samples-');
    writeFile(repo, '.codegraph/logs/query.jsonl', [
      '{not valid json',
      JSON.stringify({
        ts: '2026-06-22T00:00:00.000Z',
        event: 'query',
        toolName: 'codegraph_status',
        routedToolName: 'codegraph_status',
      }),
    ].join('\n'));

    const summary = JSON.parse(execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'logs',
      '--root',
      repo,
      '--summary',
      '--invalid',
    ], { encoding: 'utf-8' })) as {
      invalidLines?: number;
      invalidSamples?: Array<{ rawLine?: number; reason?: string }>;
      totalEvents?: number;
    };

    expect(summary.invalidLines).toBe(1);
    expect(summary.invalidSamples?.[0]).toMatchObject({
      rawLine: 1,
      reason: 'Invalid JSON',
    });
    expect(summary.totalEvents).toBe(1);
  });

  it('matches nested event namespaces with a prefix filter', () => {
    const repo = tempDir('codegraph-readiness-log-event-namespace-');
    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: '2026-06-22T00:00:00.000Z',
        event: 'watch.refresh.failed',
        toolName: 'codegraph_health',
        routedToolName: 'codegraph_health',
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:01.000Z',
        event: 'watch.refresh.succeeded',
        toolName: 'codegraph_health',
        routedToolName: 'codegraph_health',
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:02.000Z',
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
      }),
    ].join('\n'));

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'logs',
      '--root',
      repo,
      '--event',
      'watch',
    ], { encoding: 'utf-8' });

    const lines = output.trim().split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ event: 'watch.refresh.failed' });
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ event: 'watch.refresh.succeeded' });
  });

  it('supports exact nested event filters', () => {
    const repo = tempDir('codegraph-readiness-log-event-namespace-exact-');
    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: '2026-06-22T00:00:00.000Z',
        event: 'watch.refresh.failed',
        toolName: 'codegraph_health',
        routedToolName: 'codegraph_health',
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:01.000Z',
        event: 'watch.refresh.succeeded',
        toolName: 'codegraph_health',
        routedToolName: 'codegraph_health',
      }),
    ].join('\n'));

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'logs',
      '--root',
      repo,
      '--event',
      'watch.refresh.failed',
    ], { encoding: 'utf-8' });

    const lines = output.trim().split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ event: 'watch.refresh.failed' });
  });

  it('supports nested event prefix filtering in summaries', () => {
    const repo = tempDir('codegraph-readiness-log-event-summary-prefix-');
    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: '2026-06-22T00:00:00.000Z',
        event: 'watch.refresh.failed',
        toolName: 'codegraph_health',
        routedToolName: 'codegraph_health',
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:01.000Z',
        event: 'watch.refresh.succeeded',
        toolName: 'codegraph_health',
        routedToolName: 'codegraph_health',
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:02.000Z',
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'review_patch',
      }),
    ].join('\n'));

    const summary = JSON.parse(execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'logs',
      '--root',
      repo,
      '--summary',
      '--event',
      'watch.refresh',
    ], { encoding: 'utf-8' })) as {
      totalEvents?: number;
      filters?: { event?: string };
      queryEvents?: number;
    };

    expect(summary.totalEvents).toBe(2);
    expect(summary.queryEvents).toBe(0);
    expect(summary.filters).toMatchObject({
      event: 'watch.refresh',
    });
  });

  it('supports bounded time windows in summaries', () => {
    const repo = tempDir('codegraph-readiness-log-summary-time-window-');
    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: '2026-06-22T00:00:00.000Z',
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'codegraph_context',
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:01.000Z',
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:02.000Z',
        event: 'query',
        toolName: 'search_symbol',
        routedToolName: 'search_symbol',
      }),
    ].join('\n'));

    const summary = JSON.parse(execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'logs',
      '--root',
      repo,
      '--summary',
      '--tool',
      'codegraph_context',
      '--since',
      '2026-06-22T00:00:00.500Z',
      '--until',
      '2026-06-22T00:00:01.500Z',
    ], { encoding: 'utf-8' })) as {
      totalEvents?: number;
      queryEvents?: number;
      filters?: { since?: string; until?: string };
    };

    expect(summary.totalEvents).toBe(1);
    expect(summary.queryEvents).toBe(1);
    expect(summary.filters).toMatchObject({
      since: '2026-06-22T00:00:00.500Z',
      until: '2026-06-22T00:00:01.500Z',
    });
  });

  it('rejects inverted time windows', () => {
    const repo = tempDir('codegraph-readiness-log-summary-time-window-invalid-');
    writeFile(repo, '.codegraph/logs/query.jsonl', JSON.stringify({
      ts: '2026-06-22T00:00:00.000Z',
      event: 'query',
      toolName: 'codegraph_status',
      routedToolName: 'codegraph_status',
    }));

    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'logs',
      '--root',
      repo,
      '--summary',
      '--since',
      '2026-06-22T00:05:00Z',
      '--until',
      '2026-06-22T00:01:00Z',
    ], { encoding: 'utf-8' })).toThrow(/Invalid --until value:/);
  });

  it('accepts event names case-insensitively', () => {
    const repo = tempDir('codegraph-readiness-log-event-case-');
    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: '2026-06-22T00:00:00.000Z',
        event: 'query',
        toolName: 'codegraph_status',
        routedToolName: 'codegraph_status',
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:01.000Z',
        event: 'watch',
        toolName: 'codegraph_health',
        routedToolName: 'codegraph_health',
      }),
    ].join('\n'));

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'logs',
      '--root',
      repo,
      '--event',
      'WATCH',
    ], { encoding: 'utf-8' });

    const lines = output.trim().split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '{}') as { event?: string };
    expect(parsed.event).toBe('watch');
  });

  it('normalizes whitespace around event names', () => {
    const repo = tempDir('codegraph-readiness-log-event-whitespace-');
    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: '2026-06-22T00:00:00.000Z',
        event: 'watch',
        toolName: 'codegraph_health',
        routedToolName: 'codegraph_health',
      }),
    ].join('\n'));

    const output = execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'logs',
      '--root',
      repo,
      '--event',
      '  watch  ',
    ], { encoding: 'utf-8' });

    const lines = output.trim().split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '{}') as { event?: string };
    expect(parsed.event).toBe('watch');
  });

  it('rejects unsupported log event filters', () => {
    const repo = tempDir('codegraph-readiness-log-summary-invalid-event-');
    writeFile(repo, '.codegraph/logs/query.jsonl', JSON.stringify({
      ts: '2026-06-22T00:00:00.000Z',
      event: 'query',
      toolName: 'codegraph_status',
      routedToolName: 'codegraph_status',
      durationMs: 10,
      responseChars: 100,
      result: {
        ok: true,
      },
    }));

    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'logs',
      '--root',
      repo,
      '--summary',
      '--event',
      'invalid',
    ], { encoding: 'utf-8' })).toThrow(/Invalid --event value: invalid\. Supported events: query, watch/);
  });

  it('rejects invalid --since timestamps', () => {
    const repo = tempDir('codegraph-readiness-log-summary-invalid-since-');
    writeFile(repo, '.codegraph/logs/query.jsonl', JSON.stringify({
      ts: '2026-06-22T00:00:00.000Z',
      event: 'query',
      toolName: 'codegraph_status',
      routedToolName: 'codegraph_status',
      durationMs: 10,
      responseChars: 100,
      result: { ok: true },
    }));

    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'logs',
      '--root',
      repo,
      '--summary',
      '--since',
      'not-a-real-time',
    ], { encoding: 'utf-8' })).toThrow(/Invalid --since value: not-a-real-time/);
  });

  it('rejects invalid --until timestamps', () => {
    const repo = tempDir('codegraph-readiness-log-summary-invalid-until-');
    writeFile(repo, '.codegraph/logs/query.jsonl', JSON.stringify({
      ts: '2026-06-22T00:00:00.000Z',
      event: 'query',
      toolName: 'codegraph_status',
      routedToolName: 'codegraph_status',
      durationMs: 10,
      responseChars: 100,
      result: { ok: true },
    }));

    expect(() => execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'logs',
      '--root',
      repo,
      '--summary',
      '--until',
      'not-a-real-time',
    ], { encoding: 'utf-8' })).toThrow(/Invalid --until value: not-a-real-time/);
  });

  it('combines summary filters by tool, event, and since', () => {
    const repo = tempDir('codegraph-readiness-log-summary-combo-');
    writeFile(repo, '.codegraph/logs/query.jsonl', [
      JSON.stringify({
        ts: '2026-06-22T00:00:00.000Z',
        event: 'watch',
        toolName: 'codegraph_context',
        routedToolName: 'codegraph_context',
        durationMs: 8,
        responseChars: 50,
        result: {
          ok: true,
        },
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:01.000Z',
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'get_change_pack',
        durationMs: 1200,
        responseChars: 150,
        result: {
          stale: true,
          indexFreshness: { isStale: true },
        },
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:01.900Z',
        event: 'query',
        toolName: 'search_symbol',
        routedToolName: 'search_symbol',
        durationMs: 400,
        responseChars: 80,
        result: {
          answerable: false,
        },
      }),
      JSON.stringify({
        ts: '2026-06-22T00:00:02.000Z',
        event: 'query',
        toolName: 'codegraph_context',
        routedToolName: 'review_patch',
        durationMs: 200,
        responseChars: 90,
        result: {
          answerable: false,
        },
      }),
    ].join('\n'));

    const summary = JSON.parse(execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'logs',
      '--root',
      repo,
      '--summary',
      '--tool',
      'codegraph_context',
      '--event',
      'query',
      '--since',
      '2026-06-22T00:00:01.200Z',
    ], { encoding: 'utf-8' })) as {
      totalEvents?: number;
      queryEvents?: number;
      staleQueries?: number;
      tools?: Record<string, { count?: number; stale?: number }>;
      filters?: { tool?: string; event?: string; since?: string };
    };

    expect(summary.totalEvents).toBe(1);
    expect(summary.queryEvents).toBe(1);
    expect(summary.filters).toMatchObject({
      tool: 'codegraph_context',
      event: 'query',
      since: '2026-06-22T00:00:01.200Z',
    });
    expect(summary.staleQueries).toBe(0);
    expect(summary.tools).toEqual({
      codegraph_context: {
        count: 1,
        stale: 0,
        degraded: 0,
        debugTimed: 0,
        fallback: 0,
        avgMs: 200,
        maxMs: 200,
      },
    });
  });

  it('recognizes artifact-only setup as usable but recommends graph indexing', async () => {
    const repo = tempDir('codegraph-readiness-artifact-');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
}
`);
    await buildLocalArtifactIndex(repo);

    const readiness = inspectWorkspaceReadiness(repo);

    expect(readiness.ok).toBe(true);
    expect(readiness.state).toBe('artifact_only');
    expect(readiness.capabilities).toMatchObject({
      graphQueries: false,
      embeddedArtifact: true,
      facadeContext: true,
    });
    expect(readiness.artifact.state).toBe('ready');
    expect(readiness.nextActions[0]).toMatchObject({
      command: `codegraph index --root "${repo}"`,
      reason: 'Enable precise graph queries, impact analysis, and indexed source slices.',
    });
  });

  it('logs degraded MCP fallback context when the SQLite graph is not indexed', async () => {
    const repo = tempDir('codegraph-readiness-mcp-fallback-');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void refundPayment() {
  }
}
`);

    const client = new Client({ name: 'codegraph-fallback-log-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
        'src/cli.ts',
        'mcp',
        '--root',
        repo,
        '--mcp-profile',
        'client',
        '--no-prewarm',
      ],
    });

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'codegraph_context',
        arguments: {
          task: 'Find PaymentService refundPayment implementation',
        },
      });
      const parsed = JSON.parse(firstMcpText(result)) as {
        degraded?: boolean;
        source?: string;
      };

      expect(parsed.degraded).toBe(true);
      expect(parsed.source).toBe('local_filesystem_fallback');

      const logLines = fs.readFileSync(path.join(repo, '.codegraph', 'logs', 'query.jsonl'), 'utf-8')
        .trim()
        .split(/\r?\n/);
      const logEntry = JSON.parse(logLines.at(-1) ?? '{}') as {
        event?: string;
        toolName?: string;
        routedToolName?: string;
        result?: { degraded?: boolean; source?: string };
      };
      expect(logEntry.event).toBe('query');
      expect(logEntry.toolName).toBe('codegraph_context');
      expect(logEntry.routedToolName).toBe('get_research_pack');
      expect(logEntry.result).toMatchObject({
        degraded: true,
        source: 'local_filesystem_fallback',
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it('reports a fully indexed workspace as ready without setup actions', async () => {
    const repo = tempDir('codegraph-readiness-ready-');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
}
`);
    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    const indexed = await new V2Indexer(opened.db).indexWorkspace({ root: repo });

    const readiness = inspectWorkspaceReadiness(repo);

    expect(readiness.ok).toBe(true);
    expect(readiness.state).toBe('ready');
    expect(readiness.database).toMatchObject({
      ok: true,
      state: 'ready',
      dbPath: path.join(repo, '.codegraph', 'graph.sqlite'),
      snapshotId: indexed.snapshotId,
    });
    expect(readiness.capabilities).toMatchObject({
      graphQueries: true,
      facadeContext: true,
    });
    expect(readiness.nextActions).toEqual([]);
  });

  it('reports stale indexed workspaces and recommends a graph refresh first', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-readiness-stale-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}
`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }

  public void refund() {
  }
}
`);

    const readiness = inspectWorkspaceReadiness(repo);

    expect(readiness.ok).toBe(true);
    expect(readiness.state).toBe('ready');
    expect(readiness.freshness).toMatchObject({
      available: true,
      isStale: true,
    });
    expect(readiness.freshness?.warning).toContain('Index may be stale');
    expect(readiness.nextActions[0]).toMatchObject({
      command: `codegraph index --root "${repo}"`,
      reason: 'Refresh the SQLite graph so query results match the current working tree.',
    });

    const doctor = JSON.parse(execFileSync(process.execPath, [
      path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
      'src/cli.ts',
      'doctor',
      '--root',
      repo,
    ], { encoding: 'utf-8' })) as {
      freshness?: { isStale?: boolean };
      capabilities?: { freshGraph?: boolean };
      nextActions?: Array<{ command?: string }>;
    };
    expect(doctor.freshness?.isStale).toBe(true);
    expect(doctor.capabilities?.freshGraph).toBe(false);
    expect(doctor.nextActions?.[0]?.command).toBe(`codegraph index --root "${repo}"`);
  });

  it('surfaces stale graph warnings on primary MCP context calls by default', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-readiness-mcp-stale-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }
}
`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    await new V2Indexer(opened.db).indexWorkspace({ root: repo });
    await opened.db.close();
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void submit() {
  }

  public void refund() {
  }
}
`);

    const client = new Client({ name: 'codegraph-readiness-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'),
        'src/cli.ts',
        'mcp',
        '--root',
        repo,
        '--mcp-profile',
        'client',
        '--no-prewarm',
      ],
    });

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'codegraph_context',
        arguments: {
          task: 'Implement PaymentService refund behavior',
          files: ['src/main/java/com/example/PaymentService.java'],
          debugTiming: true,
        },
      });
      const parsed = JSON.parse(firstMcpText(result)) as {
        debugTiming?: { totalMs?: number };
        indexFreshness?: { isStale?: boolean; warning?: string };
      };

      expect(parsed.indexFreshness?.isStale).toBe(true);
      expect(parsed.indexFreshness?.warning).toContain('Index may be stale');
      expect(parsed.debugTiming?.totalMs).toBeGreaterThanOrEqual(0);

      const logLines = fs.readFileSync(path.join(repo, '.codegraph', 'logs', 'query.jsonl'), 'utf-8')
        .trim()
        .split(/\r?\n/);
      const logEntry = JSON.parse(logLines.at(-1) ?? '{}') as {
        result?: {
          indexFreshness?: { isStale?: boolean };
          debugTiming?: { totalMs?: number; topPhase?: { name?: string } };
        };
      };
      expect(logEntry.result?.indexFreshness?.isStale).toBe(true);
      expect(logEntry.result?.debugTiming?.totalMs).toBeGreaterThanOrEqual(0);
      expect(logEntry.result?.debugTiming?.topPhase?.name).toBeTruthy();
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it('flags invalid embedded artifacts and tells the user to rebuild setup', () => {
    const repo = tempDir('codegraph-readiness-invalid-artifact-');
    const artifactPath = localArtifactIndexPath(repo);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, '{not valid json', 'utf-8');

    const readiness = inspectWorkspaceReadiness(repo);

    expect(readiness.ok).toBe(false);
    expect(readiness.state).toBe('invalid');
    expect(readiness.artifact.state).toBe('invalid');
    expect(readiness.nextActions[0]).toMatchObject({
      command: `codegraph setup --root "${repo}"`,
      reason: 'Rebuild the invalid embedded artifact and SQLite graph.',
    });
  });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, relPath: string, content: string): void {
  const absPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runGit(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function firstMcpText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.find(part => part.type === 'text')?.text ?? '';
}
