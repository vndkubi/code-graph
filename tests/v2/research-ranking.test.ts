import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodeGraphDb } from '../../src/v2/storage/database.js';
import { openCodeGraphDb } from '../../src/v2/storage/database.js';
import { V2Indexer } from '../../src/v2/index/indexer.js';
import { V2QueryService } from '../../src/v2/query/service.js';

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

describe('research-pack file ranking', () => {
  it('ranks a PascalCase class file above a generic same-word file that only mentions the term', async () => {
    const repo = tempDir('codegraph-rank-pascal-');
    // A generic file literally named `service` that merely MENTIONS payments in
    // comments/strings. Before the camelCase + compound fix this won the
    // exact-basename boost ("service") and buried the real class file.
    writeFile(repo, 'src/core/service.ts', `// generic service registry
// handles payment, refund, and order routing strings used across the app
export function registerService(name: string): void {
  // mentions payment service refund repeatedly in text only
  void name;
}
`);
    // The real implementation: a class whose PascalCase name IS the query.
    writeFile(repo, 'src/payment/PaymentService.java', `package com.example.payment;

public class PaymentService {
  public boolean refund(String id, long amount) {
    return amount > 0;
  }
}
`);

    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });
    const packet = await new V2QueryService(db).query({
      workspaceId: indexed.workspaceId,
      toolName: 'get_context_packet',
      args: {
        task: 'Find the payment service implementation and refund behavior.',
        tokenBudget: 4000,
        maxFiles: 6,
        maxSymbols: 10,
      },
    }) as { topFiles: string[] };

    const top = packet.topFiles.map(f => f.replace(/\\/g, '/'));
    const paymentIdx = top.findIndex(f => f.endsWith('PaymentService.java'));
    const genericIdx = top.findIndex(f => f.endsWith('core/service.ts'));

    expect(paymentIdx).toBeGreaterThanOrEqual(0);
    // The specific class file must outrank the generic `service.ts` (or the
    // generic file must not even make the cut).
    expect(genericIdx === -1 || paymentIdx < genericIdx).toBe(true);
  });

  it('falls back to fixture/mock sources when the concept lives only there', async () => {
    const repo = tempDir('codegraph-rank-fallback-');
    // Main source has NOTHING about payments — only unrelated generic code.
    writeFile(repo, 'src/core/logger.ts', `export function log(line: string): void {
  void line;
}
`);
    // The only payment code is under a /fixtures/ path -> classified mock_source
    // and excluded from the primary research search. The fallback tier must
    // still surface it instead of returning unrelated main-source noise.
    writeFile(repo, 'tests/fixtures/payment/PaymentService.java', `package com.example.payment;

public class PaymentService {
  public boolean refund(String id, long amount) {
    return amount > 0;
  }
}
`);

    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });
    const packet = await new V2QueryService(db).query({
      workspaceId: indexed.workspaceId,
      toolName: 'get_context_packet',
      args: {
        task: 'Find the payment service implementation and refund behavior.',
        tokenBudget: 4000,
        maxFiles: 6,
        maxSymbols: 10,
      },
    }) as { topFiles: string[]; relevantSymbols?: Array<{ file?: string }> };

    const top = packet.topFiles.map(f => f.replace(/\\/g, '/'));
    expect(top.some(f => f.endsWith('PaymentService.java'))).toBe(true);
  });

  it('keeps other sentence terms when the query also contains a hyphenated/capitalized identifier-like word', async () => {
    const repo = tempDir('codegraph-rank-blend-');
    // `identifierSearchTerms` treats a hyphenated English compound the same as
    // a real dotted/hyphenated code identifier. Before the blend fix,
    // `fileSearchCandidateTerms` found "right-sizing" as an "explicit" term
    // and returned ONLY that term, discarding every other word in the
    // sentence -- so a file relevant only via "tokenizer" was never searched
    // for at all, regardless of ranking/caps.
    writeFile(repo, 'src/query/tokenizer.ts', `// Splits a search query into normalized tokens for matching.
export function tokenizeQuery(text: string): string[] {
  return text.toLowerCase().split(/\\s+/);
}
`);
    writeFile(repo, 'src/query/rightsizing.ts', `// Trims evidence candidates down to a relevance-cliff cutoff.
export function rightSizeCandidates(rows: unknown[]): unknown[] {
  return rows;
}
`);

    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });
    const result = await new V2QueryService(db).query({
      workspaceId: indexed.workspaceId,
      toolName: 'search_files',
      args: {
        query: 'How does the query tokenizer work, and how does relevance right-sizing affect results?',
        limit: 10,
      },
    }) as { files: Array<{ path: string }> };

    const paths = result.files.map(f => f.path.replace(/\\/g, '/'));
    expect(paths.some(p => p.endsWith('rightsizing.ts'))).toBe(true);
    expect(paths.some(p => p.endsWith('tokenizer.ts'))).toBe(true);
  });

  it('surfaces a concept-canonical class (auth) that shares NO token with the query, over a same-word collision', async () => {
    const repo = tempDir('codegraph-concept-auth-');
    // Collision noise: entities that match the incidental token "user".
    writeFile(repo, 'src/main/java/com/example/user/User.java', `package com.example.user;
public class User {
  private String name;
  public String getName() { return name; }
}
`);
    writeFile(repo, 'src/main/java/com/example/user/BookUserReadPosition.java', `package com.example.user;
public class BookUserReadPosition {
  private int position;
  public int getPosition() { return position; }
}
`);
    // The canonical auth code. Its name contains NEITHER "authentication" nor
    // "login" — pure token ranking cannot find it; only the concept boost can.
    writeFile(repo, 'src/main/java/com/example/security/AuthorizationService.java', `package com.example.security;
public class AuthorizationService {
  public String getCurrentUser(String token) { return token; }
  public void assertLoggedIn(String principal) { }
}
`);

    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });
    const packet = await new V2QueryService(db).query({
      workspaceId: indexed.workspaceId,
      toolName: 'get_research_pack',
      args: { target: 'How does user authentication and login work end to end?', taskType: 'architecture', tokenBudget: 5000 },
    }) as { topFiles: string[]; definitionCandidates: Array<{ symbol: string }>; trustPosture?: string; retrievalQuality?: { tier: string } };

    const top = packet.topFiles.map(f => f.replace(/\\/g, '/'));
    // Concept boost surfaced the auth class the token ranker would have missed.
    expect(top.some(f => f.endsWith('AuthorizationService.java'))).toBe(true);
    // Concept satisfied -> calibration treats retrieval as strong (not flagged weak).
    expect(packet.retrievalQuality?.tier).not.toBe('weak');
  });

  it('flags weak retrievalQuality + spot_check when the query names a concept the repo does not implement', async () => {
    const repo = tempDir('codegraph-concept-weak-');
    // Only "user" entities; NO auth code at all. "user" makes the pack structurally
    // sufficient, but nothing satisfies the auth concept -> a keyword collision.
    writeFile(repo, 'src/main/java/com/example/user/User.java', `package com.example.user;
public class User {
  private String name;
  public String getName() { return name; }
}
`);
    writeFile(repo, 'src/main/java/com/example/user/BookUserReadPosition.java', `package com.example.user;
public class BookUserReadPosition {
  private int position;
  public int getPosition() { return position; }
}
`);

    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });
    const packet = await new V2QueryService(db).query({
      workspaceId: indexed.workspaceId,
      toolName: 'get_research_pack',
      args: { target: 'How does user authentication and login work?', taskType: 'architecture', tokenBudget: 5000 },
    }) as { answerable: boolean; confidence: number; trustPosture?: string; retrievalQuality?: { tier: string; note?: string; suggestedFollowup?: string } };

    // Still structurally answerable (something was found) — we do not add round-trips...
    expect(packet.answerable).toBe(true);
    // ...but the collision is flagged instead of silently trusted.
    expect(packet.retrievalQuality?.tier).toBe('weak');
    expect(packet.trustPosture).toBe('spot_check_recommended');
    expect(packet.confidence).toBeLessThanOrEqual(0.6);
    expect(String(packet.retrievalQuality?.suggestedFollowup ?? '')).toMatch(/auth/i);
  });

  it('contributes a BM25 textual-relevance signal to file ranking', async () => {
    const repo = tempDir('codegraph-bm25-');
    writeFile(repo, 'src/payment/PaymentService.java', `package com.example.payment;

public class PaymentService {
  public boolean refund(String paymentId, long amount) {
    return amount > 0;
  }
}
`);
    const { db } = await openDb(repo);
    const indexed = await new V2Indexer(db).indexWorkspace({ root: repo });
    const result = await new V2QueryService(db).query({
      workspaceId: indexed.workspaceId,
      toolName: 'search_files',
      args: { query: 'payment refund', limit: 5, explainRank: true },
    }) as { files: Array<{ path: string; rankExplanation?: string[] }> };

    const match = result.files.find(f => f.path.replace(/\\/g, '/').endsWith('PaymentService.java'));
    expect(match).toBeTruthy();
    expect((match?.rankExplanation ?? []).some(factor => /BM25/.test(factor))).toBe(true);
  });
});

async function openDb(root: string): Promise<{ db: CodeGraphDb }> {
  const opened = await openCodeGraphDb(root);
  dbs.push(opened.db);
  return opened;
}

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
