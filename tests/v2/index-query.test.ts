import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openCodeGraphDb } from '../../src/v2/storage/database.js';
import { V2Indexer } from '../../src/v2/index/indexer.js';
import { V2QueryService } from '../../src/v2/query/service.js';
import { generateSyntheticJavaRepo } from '../../src/v2/benchmark/synthetic-java.js';

const tempDirs: string[] = [];
const dbs: Database[] = [];
const JAVA_FIXTURE = path.resolve('tests/fixtures/java-project');

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('v2 SQLite index and query service', () => {
  it('indexes Java symbols into persistent storage and serves search queries', () => {
    const home = tempDir('codegraph-home-');
    const { db } = openDb(home);
    const indexer = new V2Indexer(db);
    const result = indexer.indexWorkspace({ root: JAVA_FIXTURE });

    expect(result.filesTotal).toBeGreaterThan(0);
    expect(result.filesParsed).toBeGreaterThan(0);

    const queries = new V2QueryService(db);
    const search = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'PaymentService', kind: 'class' },
    }) as { symbols: Array<{ name: string; file: string }> };

    expect(search.symbols.some(symbol => symbol.name === 'PaymentService')).toBe(true);

    const callers = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'PaymentGateway.processPayment' },
    }) as { callers: Array<{ callee: string; resolution_kind: string; confidence: number }> };

    expect(callers.callers.some(call => call.callee === 'PaymentGateway.processPayment')).toBe(true);
    expect(callers.callers.some(call => call.resolution_kind === 'receiver-field' && call.confidence === 0.8)).toBe(true);
  });

  it('ranks multi-token natural-language symbol searches', () => {
    const home = tempDir('codegraph-home-');
    const { db } = openDb(home);
    const indexer = new V2Indexer(db);
    const result = indexer.indexWorkspace({ root: JAVA_FIXTURE });
    const queries = new V2QueryService(db);

    const search = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'Payment Gateway', kind: 'class', limit: 10 },
    }) as {
      symbols: Array<{ name: string; matchedTokens: string[]; searchScore: number; matchReason: string }>;
      searchMode: string;
    };

    expect(search.searchMode).toBe('multi-token-ranked');
    expect(search.symbols[0]?.name).toBe('PaymentGateway');
    expect(search.symbols[0]?.matchedTokens).toContain('payment');
    expect(search.symbols[0]?.matchedTokens).toContain('gateway');
    expect(search.symbols[0]?.searchScore).toBeGreaterThan(80);
    expect(search.symbols[0]?.matchReason).toContain('match');
  });

  it('uses entry-point intent ranking and hides lombok synthetic symbols by default', () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-intent-');
    writeFile(repo, 'src/main/java/com/example/DemoApplication.java', `package com.example;

import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class DemoApplication {
    public static void main(String[] args) {
    }
}
`);
    writeFile(repo, 'src/main/java/com/example/PointExtractionResult.java', `package com.example;

public class PointExtractionResult {
}
`);
    writeFile(repo, 'src/main/java/com/example/UserProfile.java', `package com.example;

import lombok.Data;

@Data
public class UserProfile {
    private String name;
}
`);

    const { db } = openDb(home);
    const indexer = new V2Indexer(db);
    const result = indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const entrySearch = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'main application entry point', explainRank: true, limit: 5 },
    }) as {
      intent: string;
      symbols: Array<{ name: string; matchReason: string; rankExplanation: string[] }>;
    };

    expect(entrySearch.intent).toBe('entry_point');
    expect(entrySearch.symbols[0]?.name).toBe('DemoApplication');
    expect(entrySearch.symbols[0]?.matchReason).toBe('entry-point intent match');
    expect(entrySearch.symbols[0]?.rankExplanation.some(reason => reason.includes('@SpringBootApplication'))).toBe(true);
    expect(entrySearch.symbols.some(symbol => symbol.name === 'main')).toBe(true);
    expect(entrySearch.symbols[0]?.name).not.toBe('PointExtractionResult');

    const defaultGetterSearch = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'getName', limit: 10 },
    }) as { symbols: Array<{ name: string }> };
    expect(defaultGetterSearch.symbols.some(symbol => symbol.name === 'getName')).toBe(false);

    const syntheticGetterSearch = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'getName', includeSynthetic: true, limit: 10 },
    }) as { symbols: Array<{ name: string; synthetic: boolean }> };
    expect(syntheticGetterSearch.symbols.some(symbol => symbol.name === 'getName' && symbol.synthetic)).toBe(true);
  });

  it('composes Spring endpoint paths and reports partial path resolution', () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-spring-endpoints-');
    writeFile(repo, 'src/main/java/com/example/NotebookController.java', `package com.example;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping(API + NOTEBOOKS)
public class NotebookController {
    private static final String API = "/api";
    private static final String NOTEBOOKS = "/notebooks";
    private static final String CREATE = "/create";

    @GetMapping(path = "/{id}")
    public String getNotebook(String id) {
        return id;
    }

    @PostMapping(CREATE)
    public String createNotebook() {
        return "created";
    }
}
`);
    writeFile(repo, 'src/main/java/com/example/PartialController.java', `package com.example;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping(ExternalRoutes.BASE)
public class PartialController {
    @GetMapping
    public String list() {
        return "partial";
    }
}
`);

    const { db } = openDb(home);
    const indexer = new V2Indexer(db);
    const result = indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const endpoints = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'find_endpoints',
      args: { method: 'GET', limit: 20 },
    }) as {
      endpoints: Array<{
        method: string;
        path: string;
        pathResolution: string;
        pathResolutionReason?: string;
        handlerSymbol: string;
      }>;
    };

    expect(endpoints.endpoints).toContainEqual(expect.objectContaining({
      method: 'GET',
      path: '/api/notebooks/{id}',
      pathResolution: 'exact',
    }));

    const partial = endpoints.endpoints.find(endpoint => endpoint.handlerSymbol.includes('PartialController.list'));
    expect(partial).toMatchObject({
      path: '/',
      pathResolution: 'partial',
    });
    expect(partial?.pathResolutionReason).toContain('Could not resolve RequestMapping path expression');

    const postEndpoints = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'find_endpoints',
      args: { method: 'POST', path: '/api/notebooks/create' },
    }) as { endpoints: Array<{ path: string; pathResolution: string }> };
    expect(postEndpoints.endpoints[0]).toMatchObject({
      path: '/api/notebooks/create',
      pathResolution: 'exact',
    });

    const stats = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_index_stats',
      args: {},
    }) as { diagnostics: { frameworkWarnings: { endpointPathUnresolvedCount: number } } };
    expect(stats.diagnostics.frameworkWarnings.endpointPathUnresolvedCount).toBeGreaterThan(0);
  });

  it('serves agent-oriented file, reference, dependency, and mixed search APIs', () => {
    const home = tempDir('codegraph-home-');
    const { db } = openDb(home);
    const indexer = new V2Indexer(db);
    const result = indexer.indexWorkspace({ root: JAVA_FIXTURE });
    const queries = new V2QueryService(db);

    const fileSearch = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_files',
      args: { query: 'Payment Gateway', limit: 5, explainRank: true },
    }) as {
      files: Array<{
        path: string;
        topSymbols: Array<{ name: string }>;
        rankExplanation?: string[];
      }>;
      totalFound: number;
    };

    expect(fileSearch.totalFound).toBeGreaterThan(0);
    expect(fileSearch.files[0]?.path).toContain('PaymentGateway.java');
    expect(fileSearch.files[0]?.topSymbols.some(symbol => symbol.name === 'PaymentGateway')).toBe(true);
    expect(fileSearch.files[0]?.rankExplanation?.length).toBeGreaterThan(0);

    const references = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'find_references',
      args: { symbol: 'PaymentGateway.processPayment', kind: 'all', groupBy: 'file', limit: 1 },
    }) as {
      references: Array<{ kind: string; file: string }>;
      groups: Array<{ key: string; count: number }>;
      totalCount: number;
      truncated: boolean;
      nextCursor?: string;
    };

    expect(references.totalCount).toBeGreaterThan(1);
    expect(references.references.length).toBe(1);
    expect(references.truncated).toBe(true);
    expect(references.nextCursor).toBe('1');
    expect(references.groups.length).toBeGreaterThan(0);

    const deps = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'trace_dependencies',
      args: {
        target: 'PaymentService.java',
        direction: 'dependencies',
        depth: 1,
      },
    }) as {
      seedFiles: string[];
      edges: Array<{ toFile: string }>;
      transitiveFiles: string[];
    };

    expect(deps.seedFiles[0]).toContain('PaymentService.java');
    expect(deps.edges.some(edge => edge.toFile.includes('PaymentGateway.java'))).toBe(true);
    expect(deps.transitiveFiles.some(file => file.includes('PaymentGateway.java'))).toBe(true);

    const mixed = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_code',
      args: { query: 'PaymentService', limit: 5 },
    }) as {
      sections: {
        files: { files: unknown[] };
        symbols: { symbols: unknown[] };
        references?: { references: unknown[] };
        dependencies?: { edges: unknown[] };
      };
      summary: { fileMatches: number; symbolMatches: number };
    };

    expect(mixed.summary.fileMatches).toBeGreaterThan(0);
    expect(mixed.summary.symbolMatches).toBeGreaterThan(0);
    expect(mixed.sections.files.files.length).toBeGreaterThan(0);
    expect(mixed.sections.symbols.symbols.length).toBeGreaterThan(0);
    expect(mixed.sections.references?.references.length).toBeGreaterThan(0);
    expect(mixed.sections.dependencies?.edges.length).toBeGreaterThan(0);
  });

  it('returns bounded source snippets for symbols, files, and endpoints', () => {
    const home = tempDir('codegraph-home-');
    const { db } = openDb(home);
    const indexer = new V2Indexer(db);
    const result = indexer.indexWorkspace({ root: JAVA_FIXTURE });
    const queries = new V2QueryService(db);

    const symbolSearch = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'PaymentService', limit: 1, includeSnippets: true, snippetLines: 5 },
    }) as { symbols: Array<{ snippet?: { text: string; startLine: number; endLine: number } }> };

    expect(symbolSearch.symbols[0]?.snippet?.text).toContain('PaymentService');
    expect(symbolSearch.symbols[0]?.snippet?.endLine).toBeGreaterThanOrEqual(symbolSearch.symbols[0]?.snippet?.startLine ?? 0);

    const fileSearch = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_files',
      args: { query: 'Payment Gateway', limit: 1, includeSnippets: true, snippetLines: 5 },
    }) as { files: Array<{ snippet?: { text: string } }> };

    expect(fileSearch.files[0]?.snippet?.text).toContain('PaymentGateway');

    const endpointRepo = tempDir('codegraph-snippet-endpoint-');
    writeFile(endpointRepo, 'src/main/java/com/example/OrderResource.java', `package com.example;

import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;

@Path("/orders")
public class OrderResource {
    @POST
    @Path("/create")
    public String create() {
        return "ok";
    }
}
`);
    const endpointIndex = indexer.indexWorkspace({ root: endpointRepo });
    const endpoints = queries.query({
      workspaceId: endpointIndex.workspaceId,
      toolName: 'find_endpoints',
      args: { method: 'POST', path: '/orders/create', limit: 1, includeSnippets: true, snippetLines: 5 },
    }) as { endpoints: Array<{ snippet?: { text: string } }> };

    expect(endpoints.endpoints[0]?.snippet?.text).toContain('@POST');
  });

  it('resolves Java parameter and local-variable receiver calls', () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-receiver-types-');
    writeFile(repo, 'src/main/java/com/example/LocalCallService.java', `package com.example;

public class LocalCallService {
    public void execute(PaymentGateway gateway, PaymentInfo paymentInfo) {
        gateway.processPayment(paymentInfo.getAmount());
        PaymentGateway localGateway = gateway;
        localGateway.processRefund("tx-1");
    }
}
`);
    writeFile(repo, 'src/main/java/com/example/PaymentGateway.java', `package com.example;

public interface PaymentGateway {
    void processPayment(double amount);
    void processRefund(String transactionId);
}
`);
    writeFile(repo, 'src/main/java/com/example/InMemoryPaymentGateway.java', `package com.example;

public class InMemoryPaymentGateway implements PaymentGateway {
    public void processPayment(double amount) {
    }

    public void processRefund(String transactionId) {
    }
}
`);
    writeFile(repo, 'src/main/java/com/example/PaymentInfo.java', `package com.example;

public class PaymentInfo {
    public double getAmount() {
        return 10.0;
    }
}
`);

    const { db } = openDb(home);
    const indexer = new V2Indexer(db);
    const result = indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const paymentCallers = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'PaymentGateway.processPayment' },
    }) as { callers: Array<{ callee: string; resolution_kind: string }> };

    expect(paymentCallers.callers).toContainEqual(expect.objectContaining({
      callee: 'PaymentGateway.processPayment',
      resolution_kind: 'static-or-type-receiver',
    }));

    const refundCallers = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'PaymentGateway.processRefund' },
    }) as { callers: Array<{ callee: string; resolution_kind: string }> };

    expect(refundCallers.callers).toContainEqual(expect.objectContaining({
      callee: 'PaymentGateway.processRefund',
      resolution_kind: 'static-or-type-receiver',
    }));

    const amountCallers = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'PaymentInfo.getAmount' },
    }) as { callers: Array<{ callee: string; resolution_kind: string }> };

    expect(amountCallers.callers).toContainEqual(expect.objectContaining({
      callee: 'PaymentInfo.getAmount',
      resolution_kind: 'static-or-type-receiver',
    }));

    const implementationCallers = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'InMemoryPaymentGateway.processPayment' },
    }) as { callers: Array<{ callee: string; resolution_kind: string }> };

    expect(implementationCallers.callers).toContainEqual(expect.objectContaining({
      callee: 'InMemoryPaymentGateway.processPayment',
      resolution_kind: 'interface-implementation',
    }));
  });

  it('warns about stale snapshots and can auto-refresh on query', () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-stale-');
    writeFile(repo, 'src/main/java/com/example/Demo.java', `package com.example;

public class Demo {
}
`);

    const { db } = openDb(home);
    const indexer = new V2Indexer(db);
    const result = indexer.indexWorkspace({ root: repo });
    writeFile(repo, 'src/main/java/com/example/Demo.java', `package com.example;

public class DemoChanged {
}
`);

    const queries = new V2QueryService(db);
    const staleSearch = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'Demo', limit: 5 },
    }) as { indexFreshness?: { isStale: boolean; dirtyFiles?: { modifiedCount: number } } };

    expect(staleSearch.indexFreshness?.isStale).toBe(true);
    expect(staleSearch.indexFreshness?.dirtyFiles?.modifiedCount).toBe(1);

    const refreshedSearch = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'DemoChanged', limit: 5, autoRefresh: true },
    }) as { symbols: Array<{ name: string }>; indexFreshness?: { isStale: boolean } };

    expect(refreshedSearch.symbols.some(symbol => symbol.name === 'DemoChanged')).toBe(true);
    expect(refreshedSearch.indexFreshness).toBeUndefined();
  });

  it('uses workspace keys to distinguish Docker-mounted repositories with the same container root', () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-workspace-key-');
    writeFile(repo, 'src/main/java/com/example/Demo.java', `package com.example;

public class Demo {
}
`);

    const { db } = openDb(home);
    const indexer = new V2Indexer(db);
    const first = indexer.indexWorkspace({ root: repo, workspaceKey: 'C:/repos/app-main' });
    const same = indexer.indexWorkspace({ root: repo, workspaceKey: 'c:/repos/app-main' });
    const second = indexer.indexWorkspace({ root: repo, workspaceKey: 'C:/repos/app-feature' });

    expect(same.workspaceId).toBe(first.workspaceId);
    expect(second.workspaceId).not.toBe(first.workspaceId);
  });

  it('refreshes after git checkout when autoRefresh is enabled', () => {
    if (!hasGit()) return;

    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-git-checkout-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/BranchMarker.java', `package com.example;

public class MainBranchMarker {
}
`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'main branch');
    const initialBranch = gitOutput(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
    runGit(repo, 'checkout', '-b', 'feature');
    writeFile(repo, 'src/main/java/com/example/BranchMarker.java', `package com.example;

public class FeatureBranchMarker {
}
`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'feature branch');
    runGit(repo, 'checkout', initialBranch);

    const { db } = openDb(home);
    const indexer = new V2Indexer(db);
    const result = indexer.indexWorkspace({ root: repo, workspaceKey: 'checkout-same-folder' });
    const queries = new V2QueryService(db);

    const mainSearch = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'MainBranchMarker', limit: 5 },
    }) as { symbols: Array<{ name: string }> };
    expect(mainSearch.symbols.some(symbol => symbol.name === 'MainBranchMarker')).toBe(true);

    runGit(repo, 'checkout', 'feature');

    const featureSearch = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'FeatureBranchMarker', limit: 5, autoRefresh: true },
    }) as { symbols: Array<{ name: string }>; indexFreshness?: { isStale: boolean } };

    expect(featureSearch.symbols.some(symbol => symbol.name === 'FeatureBranchMarker')).toBe(true);
    expect(featureSearch.indexFreshness).toBeUndefined();
  });

  it('reuses parse cache on a second snapshot', () => {
    const home = tempDir('codegraph-home-');
    const { db } = openDb(home);
    const indexer = new V2Indexer(db);
    const first = indexer.indexWorkspace({ root: JAVA_FIXTURE });
    const second = indexer.indexWorkspace({ root: JAVA_FIXTURE });

    expect(first.filesParsed).toBeGreaterThan(0);
    expect(second.parseCacheHits).toBeGreaterThan(0);
  });

  it('discovers synthetic Jakarta endpoints', () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-synthetic-');
    generateSyntheticJavaRepo({ root: repo, files: 40, modules: 2 });

    const { db } = openDb(home);
    const indexer = new V2Indexer(db);
    const result = indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);
    const endpoints = queries.query({
      workspaceId: result.workspaceId,
      toolName: 'find_endpoints',
      args: { method: 'GET' },
    }) as { endpoints: unknown[] };

    expect(endpoints.endpoints.length).toBeGreaterThan(0);
  });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function openDb(home: string): { db: Database } {
  const opened = openCodeGraphDb(home);
  dbs.push(opened.db);
  return opened;
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

function gitOutput(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}
