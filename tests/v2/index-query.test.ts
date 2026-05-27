import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CodeGraphDb } from '../../src/v2/storage/database.js';
import { openCodeGraphDb } from '../../src/v2/storage/database.js';
import { V2Indexer } from '../../src/v2/index/indexer.js';
import { V2QueryService } from '../../src/v2/query/service.js';
import { generateSyntheticJavaRepo } from '../../src/v2/benchmark/synthetic-java.js';
import { runContextProofEval } from '../../src/v2/benchmark/context-proof.js';
import { runReviewProofEval } from '../../src/v2/benchmark/review-proof.js';

const tempDirs: string[] = [];
const dbs: CodeGraphDb[] = [];
const JAVA_FIXTURE = path.resolve('tests/fixtures/java-project');

beforeEach(async () => {
  const { db } = await openCodeGraphDb();
  try {
    await resetDb(db);
  } finally {
    await db.close();
  }
});

afterEach(async () => {
  for (const db of dbs.splice(0)) {
    await db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('v2 Postgres index and query service', () => {
  it('indexes Java symbols into persistent storage and serves search queries', async () => {
    const home = tempDir('codegraph-home-');
    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: JAVA_FIXTURE });

    expect(result.filesTotal).toBeGreaterThan(0);
    expect(result.filesParsed).toBeGreaterThan(0);

    const queries = new V2QueryService(db);
    const search = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'PaymentService', kind: 'class' },
    }) as { symbols: Array<{ name: string; file: string }> };

    expect(search.symbols.some(symbol => symbol.name === 'PaymentService')).toBe(true);

    const callers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'PaymentGateway.processPayment' },
    }) as { callers: Array<{ callee: string; resolution_kind: string; confidence: number }> };

    expect(callers.callers.some(call => call.callee === 'PaymentGateway.processPayment')).toBe(true);
    expect(callers.callers.some(call => call.resolution_kind === 'receiver-field' && call.confidence === 0.8)).toBe(true);
  });

  it('ranks multi-token natural-language symbol searches', async () => {
    const home = tempDir('codegraph-home-');
    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: JAVA_FIXTURE });
    const queries = new V2QueryService(db);

    const search = await queries.query({
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

  it('uses entry-point intent ranking and hides lombok synthetic symbols by default', async () => {
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

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const entrySearch = await queries.query({
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

    const defaultGetterSearch = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'getName', limit: 10 },
    }) as { symbols: Array<{ name: string }> };
    expect(defaultGetterSearch.symbols.some(symbol => symbol.name === 'getName')).toBe(false);

    const syntheticGetterSearch = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'getName', includeSynthetic: true, limit: 10 },
    }) as { symbols: Array<{ name: string; synthetic: boolean }> };
    expect(syntheticGetterSearch.symbols.some(symbol => symbol.name === 'getName' && symbol.synthetic)).toBe(true);
  });

  it('composes Spring endpoint paths and reports partial path resolution', async () => {
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

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const endpoints = await queries.query({
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

    const postEndpoints = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'find_endpoints',
      args: { method: 'POST', path: '/api/notebooks/create' },
    }) as { endpoints: Array<{ path: string; pathResolution: string }> };
    expect(postEndpoints.endpoints[0]).toMatchObject({
      path: '/api/notebooks/create',
      pathResolution: 'exact',
    });

    const stats = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_index_stats',
      args: {},
    }) as { diagnostics: { frameworkWarnings: { endpointPathUnresolvedCount: number } } };
    expect(stats.diagnostics.frameworkWarnings.endpointPathUnresolvedCount).toBeGreaterThan(0);
  });

  it('classifies Jakarta EE 8+ annotations across javax and jakarta namespaces', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-jakarta8-plus-');
    writeFile(repo, 'src/main/java/com/example/EventSocket.java', `package com.example;

import javax.annotation.sql.DataSourceDefinition;
import javax.faces.view.ViewScoped;
import javax.inject.Named;
import javax.json.bind.annotation.JsonbProperty;
import javax.transaction.Transactional;
import javax.websocket.OnMessage;
import javax.websocket.server.ServerEndpoint;

@Named
@ViewScoped
@ServerEndpoint("/events/{id}")
public class EventSocket {
    @JsonbProperty("event_id")
    private String eventId;

    @OnMessage
    public void onMessage(String message) {
    }

    @Transactional
    public void save() {
    }
}

@DataSourceDefinition(name = "java:global/jdbc/orders", className = "org.postgresql.ds.PGSimpleDataSource")
class DataSourceConfig {
}
`);
    writeFile(repo, 'src/main/java/com/example/OrderRepository.java', `package com.example;

import jakarta.data.repository.Param;
import jakarta.data.repository.Query;
import jakarta.data.repository.Repository;

@Repository
public interface OrderRepository {
    @Query("where id = :id")
    Order byId(@Param("id") String id);
}

class Order {
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const websocketEndpoints = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'find_endpoints',
      args: { method: 'WEBSOCKET', path: '/events', limit: 10 },
    }) as { endpoints: Array<{ method: string; path: string; framework: string; handlerSymbol: string }> };
    expect(websocketEndpoints.endpoints).toContainEqual(expect.objectContaining({
      method: 'WEBSOCKET',
      path: '/events/{id}',
      framework: 'websocket',
    }));

    const roles = async (query: string, frameworkRole: string, kind?: string) => queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query, frameworkRole, kind, limit: 10 },
    }) as Promise<{ symbols: Array<{ name: string; frameworkRole?: string }> }>;

    expect((await roles('EventSocket', 'websocket:endpoint', 'class')).symbols.some(symbol => symbol.name === 'EventSocket')).toBe(true);
    expect((await roles('eventId', 'jakarta:jsonb', 'field')).symbols.some(symbol => symbol.name === 'eventId')).toBe(true);
    expect((await roles('save', 'jakarta:transactional', 'method')).symbols.some(symbol => symbol.name === 'save')).toBe(true);
    expect((await roles('DataSourceConfig', 'jakarta:datasource', 'class')).symbols.some(symbol => symbol.name === 'DataSourceConfig')).toBe(true);
    expect((await roles('OrderRepository', 'jakarta:data', 'interface')).symbols.some(symbol => symbol.name === 'OrderRepository')).toBe(true);
    expect((await roles('byId', 'jakarta:data-query', 'method')).symbols.some(symbol => symbol.name === 'byId')).toBe(true);

    const beans = await db.prepare('SELECT implementation, scope FROM beans WHERE snapshot_id = ?').all(result.snapshotId) as Array<{ implementation: string; scope: string }>;
    expect(beans).toContainEqual(expect.objectContaining({
      implementation: 'com.example.EventSocket',
      scope: 'Named',
    }));
  });

  it('serves agent-oriented file, reference, dependency, and mixed search APIs', async () => {
    const home = tempDir('codegraph-home-');
    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: JAVA_FIXTURE });
    const queries = new V2QueryService(db);

    const fileSearch = await queries.query({
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

    const references = await queries.query({
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

    const deps = await queries.query({
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

    const mixed = await queries.query({
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

  it('returns bounded source snippets for symbols, files, and endpoints', async () => {
    const home = tempDir('codegraph-home-');
    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: JAVA_FIXTURE });
    const queries = new V2QueryService(db);

    const symbolSearch = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'PaymentService', limit: 1, includeSnippets: true, snippetLines: 5 },
    }) as { symbols: Array<{ snippet?: { text: string; startLine: number; endLine: number } }> };

    expect(symbolSearch.symbols[0]?.snippet?.text).toContain('PaymentService');
    expect(symbolSearch.symbols[0]?.snippet?.endLine).toBeGreaterThanOrEqual(symbolSearch.symbols[0]?.snippet?.startLine ?? 0);

    const fileSearch = await queries.query({
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
    const endpointIndex = await indexer.indexWorkspace({ root: endpointRepo });
    const endpoints = await queries.query({
      workspaceId: endpointIndex.workspaceId,
      toolName: 'find_endpoints',
      args: { method: 'POST', path: '/orders/create', limit: 1, includeSnippets: true, snippetLines: 5 },
    }) as { endpoints: Array<{ snippet?: { text: string } }> };

    expect(endpoints.endpoints[0]?.snippet?.text).toContain('@POST');
  });

  it('builds compact context packets and exact file slices for agent routing', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-context-packet-');
    writeFile(repo, 'package.json', JSON.stringify({
      scripts: {
        test: 'vitest run',
        typecheck: 'tsc --noEmit',
      },
    }, null, 2));
    writeFile(repo, 'src/main/java/com/example/payment/PaymentGateway.java', `package com.example.payment;

public interface PaymentGateway {
    void processRefund(String transactionId);
}
`);
    writeFile(repo, 'src/main/java/com/example/payment/PaymentService.java', `package com.example.payment;

public class PaymentService {
    private final PaymentGateway gateway;

    public PaymentService(PaymentGateway gateway) {
        this.gateway = gateway;
    }

    public void refund(String transactionId) {
        gateway.processRefund(transactionId);
    }
}
`);
    writeFile(repo, 'src/test/java/com/example/payment/PaymentServiceTest.java', `package com.example.payment;

import org.junit.jupiter.api.Test;

public class PaymentServiceTest {
    @Test
    void refundDelegatesToGateway() {
        PaymentService service = new PaymentService(null);
        service.refund("tx-1");
    }
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const packet = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_context_packet',
      args: {
        task: 'fix duplicate refund timeout in payment service',
        domain: 'payment',
        maxFiles: 4,
        maxSymbols: 6,
        tokenBudget: 4000,
        includeSnippets: true,
        snippetLines: 5,
      },
    }) as {
      candidateFiles: Array<{ file: string; snippet?: { text: string }; confidence: number }>;
      relevantSymbols: Array<{ symbol: string; lines: string }>;
      testsLikelyRelevant: Array<{ file: string }>;
      validation: { targetedTestFiles: string[]; suggestedCommands: string[] };
      nextAction: string;
      budget: { estimatedResponseTokens: number };
    };

    expect(packet.candidateFiles.length).toBeGreaterThan(0);
    expect(packet.candidateFiles.length).toBeLessThanOrEqual(4);
    expect(packet.candidateFiles.some(file => file.file.endsWith('PaymentService.java'))).toBe(true);
    expect(packet.candidateFiles.some(file => file.snippet?.text.includes('PaymentService'))).toBe(true);
    expect(packet.relevantSymbols.some(symbol => symbol.symbol.includes('PaymentService'))).toBe(true);
    expect(packet.relevantSymbols.every(symbol => symbol.lines.length > 0)).toBe(true);
    expect(packet.testsLikelyRelevant.some(test => test.file.endsWith('PaymentServiceTest.java'))).toBe(true);
    expect(packet.validation.targetedTestFiles.some(file => file.endsWith('PaymentServiceTest.java'))).toBe(true);
    expect(packet.validation.suggestedCommands.some(command => command.includes('npm test'))).toBe(true);
    expect(packet.nextAction).toContain('get_file_slice');
    expect(packet.budget.estimatedResponseTokens).toBeGreaterThan(0);

    const slice = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_file_slice',
      args: { symbol: 'PaymentService.refund', maxChars: 1000 },
    }) as { file: string; lines: string; text: string; truncated: boolean; resolvedSymbol?: { symbol: string } };

    expect(slice.file.endsWith('PaymentService.java')).toBe(true);
    expect(slice.lines).toMatch(/^\d+(-\d+)?$/);
    expect(slice.text).toContain('processRefund');
    expect(slice.truncated).toBe(false);
    expect(slice.resolvedSymbol?.symbol).toContain('PaymentService.refund');
  });

  it('builds answer-ready research and flow packs with source evidence', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-research-pack-');
    writeFile(repo, 'src/main/java/com/example/payment/PaymentGateway.java', `package com.example.payment;

public interface PaymentGateway {
    void processRefund(String transactionId);
}
`);
    writeFile(repo, 'src/main/java/com/example/payment/PaymentService.java', `package com.example.payment;

public class PaymentService {
    private final PaymentGateway gateway;

    public PaymentService(PaymentGateway gateway) {
        this.gateway = gateway;
    }

    public void refund(String transactionId) {
        gateway.processRefund(transactionId);
    }
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const researchPack = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_research_pack',
      args: {
        target: 'How does PaymentService refund call PaymentGateway processRefund?',
        taskType: 'architecture',
        tokenBudget: 5000,
      },
    }) as {
      evidenceSlices: Array<{ file: string; text: string; lines: string }>;
      completeness: { sufficientForAnswer: boolean; evidenceSliceCount: number };
      answerGuidance: string[];
      nextAction: string;
      definitionCandidates: Array<{ symbol: string; file: string }>;
      flowSteps: unknown[];
    };

    expect(researchPack.completeness.sufficientForAnswer).toBe(true);
    expect(researchPack.completeness.evidenceSliceCount).toBeGreaterThan(0);
    expect(researchPack.definitionCandidates.some(symbol => symbol.symbol.includes('PaymentService'))).toBe(true);
    expect(researchPack.evidenceSlices.some(slice => slice.file.endsWith('PaymentService.java'))).toBe(true);
    expect(researchPack.evidenceSlices.some(slice => slice.text.includes('processRefund'))).toBe(true);
    expect(researchPack.answerGuidance.join(' ')).toContain('Answer directly');
    expect(researchPack.nextAction).toContain('Answer');
    expect(researchPack.flowSteps.length).toBeGreaterThan(0);

    const flowPack = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_flow_pack',
      args: {
        target: 'PaymentService refund flow',
        tokenBudget: 5000,
      },
    }) as {
      taskType: string;
      routing: { answerDirectly: boolean };
      evidenceSlices: Array<{ text: string }>;
    };

    expect(flowPack.taskType).toBe('architecture');
    expect(flowPack.routing.answerDirectly).toBe(true);
    expect(flowPack.evidenceSlices.some(slice => slice.text.includes('processRefund'))).toBe(true);
  });

  it('simulates patch impact from changed files, symbols, and diffs', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-patch-impact-');
    writeFile(repo, 'package.json', JSON.stringify({
      scripts: {
        test: 'vitest run',
      },
    }, null, 2));
    writeFile(repo, 'src/main/java/com/example/orders/OrderController.java', `package com.example.orders;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;

@Path("/orders")
public class OrderController {
    private final OrderService service = new OrderService();

    @GET
    public String list() {
        return service.listOrders();
    }
}
`);
    writeFile(repo, 'src/main/java/com/example/orders/OrderService.java', `package com.example.orders;

public class OrderService {
    public String listOrders() {
        return "ok";
    }
}
`);
    writeFile(repo, 'src/test/java/com/example/orders/OrderServiceTest.java', `package com.example.orders;

public class OrderServiceTest {
    void listOrders() {
        new OrderService().listOrders();
    }
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);
    const diff = [
      'diff --git a/src/main/java/com/example/orders/OrderController.java b/src/main/java/com/example/orders/OrderController.java',
      '--- a/src/main/java/com/example/orders/OrderController.java',
      '+++ b/src/main/java/com/example/orders/OrderController.java',
      '@@ -8,6 +8,7 @@ public class OrderController {',
      '     @GET',
      '     public String list() {',
      '+        System.out.println("debug order list");',
      '         return service.listOrders();',
      '     }',
    ].join('\n');

    const impact = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'simulate_patch_impact',
      args: {
        files: ['src/main/java/com/example/orders/OrderService.java'],
        symbols: ['OrderController.list'],
        diff,
        limit: 20,
      },
    }) as {
      changedFiles: string[];
      changedEndpoints: Array<{ path: string }>;
      dependencyImpact: { dependents: Array<{ file: string }> };
      callImpact: { callers: Array<{ file: string; callee: string }> };
      testsLikelyRelevant: Array<{ file: string }>;
      validation: { targetedTestFiles: string[]; suggestedCommands: string[] };
      riskFlags: Array<{ type: string }>;
      summary: { blastRadius: string; changedFileCount: number };
    };

    expect(impact.changedFiles.some(file => file.endsWith('OrderService.java'))).toBe(true);
    expect(impact.changedFiles.some(file => file.endsWith('OrderController.java'))).toBe(true);
    expect(impact.changedEndpoints.some(endpoint => endpoint.path === '/orders')).toBe(true);
    expect(impact.dependencyImpact.dependents.some(row => row.file.endsWith('OrderController.java'))).toBe(true);
    expect(impact.callImpact.callers.some(call => call.file.endsWith('OrderController.java') && call.callee.includes('listOrders'))).toBe(true);
    expect(impact.testsLikelyRelevant.some(test => test.file.endsWith('OrderServiceTest.java'))).toBe(true);
    expect(impact.validation.targetedTestFiles.some(file => file.endsWith('OrderServiceTest.java'))).toBe(true);
    expect(impact.validation.suggestedCommands.some(command => command.includes('npm test'))).toBe(true);
    expect(impact.riskFlags.some(flag => flag.type === 'endpoint-change')).toBe(true);
    expect(impact.summary.changedFileCount).toBe(2);
    expect(['medium', 'high']).toContain(impact.summary.blastRadius);

    const review = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'review_patch',
      args: {
        files: ['src/main/java/com/example/orders/OrderService.java'],
        symbols: ['OrderController.list'],
        diff,
        focus: 'api-contract',
        limit: 20,
      },
    }) as {
      outputMode: string;
      reviewStatus: string;
      reviewFindings: Array<{ id: string; priority: string }>;
      lineFocus: Array<{ file: string; changeKinds: string[]; lineMappingConfidence?: string }>;
      requiredToolCalls: Array<{ tool: string }>;
      metrics: { findingCount: number; omittedHunks: number };
    };

    expect(review.outputMode).toBe('compact');
    expect(review.reviewStatus).toBe('needs-attention');
    expect(review.reviewFindings.some(finding => finding.id === 'review-endpoint-contract')).toBe(true);
    expect(review.reviewFindings.some(finding => finding.id.includes('review-debug-output'))).toBe(true);
    expect(review.lineFocus.some(hunk => hunk.file.endsWith('OrderController.java') && hunk.changeKinds.includes('debug-output'))).toBe(true);
    expect(review.lineFocus.some(hunk => hunk.file.endsWith('OrderController.java') && hunk.lineMappingConfidence === 'low')).toBe(true);
    expect(review.requiredToolCalls.some(call => call.tool === 'get_file_summary')).toBe(true);
    expect(review.metrics.findingCount).toBeGreaterThan(0);
    expect(review.metrics.omittedHunks).toBe(0);

    const matchingDiff = [
      'diff --git a/src/main/java/com/example/orders/OrderController.java b/src/main/java/com/example/orders/OrderController.java',
      '--- a/src/main/java/com/example/orders/OrderController.java',
      '+++ b/src/main/java/com/example/orders/OrderController.java',
      '@@ -10,5 +10,6 @@ public class OrderController {',
      '     @GET',
      '     public String list() {',
      '+        System.out.println("debug order list");',
      '         return service.listOrders();',
      '     }',
    ].join('\n');
    const matchingReview = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'review_patch',
      args: {
        diff: matchingDiff,
        focus: 'bug-risk',
      },
    }) as {
      lineFocus: Array<{ lineMappingConfidence?: string }>;
      requiredToolCalls: Array<{ tool: string }>;
    };
    expect(matchingReview.lineFocus.some(hunk => hunk.lineMappingConfidence === 'high')).toBe(true);
    expect(matchingReview.requiredToolCalls.some(call => call.tool === 'get_file_slice')).toBe(true);
  });

  it('indexes XML, JSON, YAML, and properties config evidence', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-config-files-');
    writeFile(repo, 'src/main/java/com/example/mapper/OrderMapper.java', `package com.example.mapper;

import com.example.model.Order;

public interface OrderMapper {
    Order selectById(Long id);
}
`);
    writeFile(repo, 'src/main/java/com/example/model/Order.java', `package com.example.model;

public class Order {
}
`);
    writeFile(repo, 'src/main/resources/com/example/mapper/OrderMapper.xml', `<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="com.example.mapper.OrderMapper">
  <resultMap id="BaseResultMap" type="com.example.model.Order">
    <id column="id" property="id"/>
  </resultMap>
  <select id="selectById" parameterType="java.lang.Long" resultMap="BaseResultMap">
    select id from oms_order where id = #{id}
  </select>
</mapper>
`);
    writeFile(repo, 'src/main/resources/application.yml', `spring:
  datasource:
    url: jdbc:mysql://localhost:3306/mall
server:
  port: 8080
`);
    writeFile(repo, 'src/main/resources/openapi.json', JSON.stringify({
      paths: {
        '/orders': {
          get: {
            operationId: 'listOrders',
          },
        },
      },
    }, null, 2));
    writeFile(repo, 'src/main/resources/rest-api-spec/api/cluster.health.json', JSON.stringify({
      'cluster.health': {
        documentation: {
          description: 'Get the cluster health status',
        },
        headers: {
          accept: ['application/json'],
        },
        url: {
          paths: [
            {
              path: '/_cluster/health',
              methods: ['GET'],
            },
          ],
        },
        params: {
          wait_for_status: {
            type: 'enum',
            options: ['green', 'yellow', 'red'],
            description: 'Wait until cluster is in a specific state',
          },
        },
      },
    }, null, 2));
    writeFile(repo, 'src/yamlRestTest/resources/rest-api-spec/test/cluster.health/10_basic.yml', `---
"cluster health basic test":
  - do:
      cluster.health:
        wait_for_status: green
`);
    writeFile(repo, 'src/main/resources/docker-compose.yml', `services:
  order-api:
    image: example/order-api:latest
    ports:
      - "8080:8080"
`);
    writeFile(repo, 'src/main/resources/application.properties', `app.feature.order-cache=true
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const xmlFiles = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_files',
      args: { query: 'OrderMapper selectById resultMap', limit: 10, explainRank: true },
    }) as {
      files: Array<{
        path: string;
        language?: string;
        parseStatus: string;
        topSymbols: Array<{ name: string; frameworkRole?: string }>;
      }>;
    };
    const mapperXml = xmlFiles.files.find(file => file.path.endsWith('OrderMapper.xml'));
    expect(mapperXml).toMatchObject({
      language: 'xml',
      parseStatus: 'ok',
    });
    expect(mapperXml?.topSymbols.some(symbol => symbol.name === 'selectById' && symbol.frameworkRole === 'mybatis:select')).toBe(true);

    const yamlSymbols = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'spring datasource url', limit: 10 },
    }) as { symbols: Array<{ name: string; file: string; frameworkRole?: string }> };
    expect(yamlSymbols.symbols).toContainEqual(expect.objectContaining({
      name: 'spring.datasource.url',
      file: expect.stringContaining('application.yml'),
      frameworkRole: 'spring:datasource',
    }));

    const openApiEndpoints = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'find_endpoints',
      args: { method: 'GET', path: '/orders', limit: 10 },
    }) as { endpoints: Array<{ path: string; method: string; framework: string; file: string }> };
    expect(openApiEndpoints.endpoints).toContainEqual(expect.objectContaining({
      path: '/orders',
      method: 'GET',
      framework: 'openapi',
      file: expect.stringContaining('openapi.json'),
    }));

    const elasticEndpoints = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'find_endpoints',
      args: { method: 'GET', path: '/_cluster/health', limit: 10 },
    }) as { endpoints: Array<{ path: string; method: string; framework: string; file: string }> };
    expect(elasticEndpoints.endpoints).toContainEqual(expect.objectContaining({
      path: '/_cluster/health',
      method: 'GET',
      framework: 'elastic-rest',
      file: expect.stringContaining('cluster.health.json'),
    }));

    const elasticParams = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'wait for status green cluster health', frameworkRole: 'elastic-rest:param', limit: 10 },
    }) as { symbols: Array<{ name: string; file: string; frameworkRole?: string }> };
    expect(elasticParams.symbols).toContainEqual(expect.objectContaining({
      name: 'cluster.health.wait_for_status',
      file: expect.stringContaining('cluster.health.json'),
      frameworkRole: 'elastic-rest:param',
    }));

    const elasticYamlParams = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: {
        query: 'cluster health basic wait for status green',
        frameworkRole: 'elastic-rest:yaml-param',
        includeTests: true,
        limit: 10,
      },
    }) as { symbols: Array<{ name: string; file: string; frameworkRole?: string }> };
    expect(elasticYamlParams.symbols).toContainEqual(expect.objectContaining({
      name: 'cluster.health.wait_for_status',
      file: expect.stringContaining('cluster.health/10_basic.yml'),
      frameworkRole: 'elastic-rest:yaml-param',
    }));

    const dockerSymbols = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'order api image', frameworkRole: 'docker:service', limit: 10 },
    }) as { symbols: Array<{ name: string; file: string; frameworkRole?: string }> };
    expect(dockerSymbols.symbols).toContainEqual(expect.objectContaining({
      name: 'services.order-api',
      file: expect.stringContaining('docker-compose.yml'),
      frameworkRole: 'docker:service',
    }));

    const propertiesSymbols = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'app feature order cache', limit: 10 },
    }) as { symbols: Array<{ name: string; file: string; frameworkRole?: string }> };
    expect(propertiesSymbols.symbols).toContainEqual(expect.objectContaining({
      name: 'app.feature.order-cache',
      file: expect.stringContaining('application.properties'),
      frameworkRole: 'config:properties-key',
    }));

    const mapperTrace = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'trace_dependencies',
      args: { target: 'OrderMapper.java', direction: 'dependencies', depth: 1 },
    }) as { edges: Array<{ toFile: string; resolutionKind: string }> };
    expect(mapperTrace.edges).toContainEqual(expect.objectContaining({
      toFile: expect.stringContaining('OrderMapper.xml'),
      resolutionKind: 'mybatis-namespace',
    }));
  });

  it('runs a context proof benchmark comparing baseline file reads to MCP slices', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-context-proof-');
    writeFile(repo, 'src/main/java/com/example/payment/PaymentGateway.java', `package com.example.payment;

public interface PaymentGateway {
    void processRefund(String transactionId);
}
`);
    writeFile(repo, 'src/main/java/com/example/payment/PaymentService.java', `package com.example.payment;

public class PaymentService {
    private final PaymentGateway gateway;

    public PaymentService(PaymentGateway gateway) {
        this.gateway = gateway;
    }

    public void refund(String transactionId) {
        gateway.processRefund(transactionId);
    }
}
`);
    writeFile(repo, 'src/test/java/com/example/payment/PaymentServiceTest.java', `package com.example.payment;

import org.junit.jupiter.api.Test;

public class PaymentServiceTest {
    @Test
    void refundDelegatesToGateway() {
        PaymentService service = new PaymentService(null);
        service.refund("tx-1");
    }
}
`);
    for (let i = 0; i < 8; i++) {
      writeFile(repo, `src/main/java/com/example/noise/NoisyPayment${i}.java`, `package com.example.noise;

/*
${'refund timeout payment noise '.repeat(250)}
*/
public class NoisyPayment${i} {
    public String value() {
        return "noise-${i}";
    }
}
`);
    }

    const { db } = await openDb(home);
    const proof = await runContextProofEval(db, repo, [{
      id: 'payment-refund-proof',
      task: 'Find PaymentService refund behavior and related tests.',
      domain: 'payment',
      baselineSearchTerms: ['refund', 'PaymentService'],
      expectedContains: ['PaymentService', 'processRefund'],
      expectedFiles: ['PaymentService.java'],
      maxFiles: 4,
      maxSymbols: 6,
      tokenBudget: 4000,
      sliceCount: 2,
    }]);

    expect(proof.totals.tasks).toBe(1);
    expect(proof.totals.baselineCorrect).toBe(1);
    expect(proof.totals.mcpCorrect).toBe(1);
    expect(proof.totals.qualityMaintained).toBe(true);
    expect(proof.totals.baselineFilesOpened).toBeGreaterThan(proof.totals.mcpSlicesOpened);
    expect(proof.totals.tokenSavingPct).toBeGreaterThan(0);
    expect(proof.tasks[0]?.mcp.slicedFiles.some(file => file.endsWith('PaymentService.java'))).toBe(true);
  });

  it('runs a review proof benchmark comparing raw file reads to review packets', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-review-proof-');
    writeFile(repo, 'src/main/java/com/example/orders/OrderController.java', `package com.example.orders;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;

@Path("/orders")
public class OrderController {
    private final OrderService service = new OrderService();

    @GET
    public String list() {
        return service.listOrders();
    }
}
`);
    writeFile(repo, 'src/main/java/com/example/orders/OrderService.java', `package com.example.orders;

public class OrderService {
    public String listOrders() {
        return "ok";
    }
}
`);
    writeFile(repo, 'src/test/java/com/example/orders/OrderServiceTest.java', `package com.example.orders;

public class OrderServiceTest {
    void listOrders() {
        new OrderService().listOrders();
    }
}
`);
    for (let i = 0; i < 10; i++) {
      writeFile(repo, `src/main/java/com/example/noise/NoisyOrder${i}.java`, `package com.example.noise;

/*
${'OrderService listOrders review noise '.repeat(220)}
*/
public class NoisyOrder${i} {
}
`);
    }

    const { db } = await openDb(home);
    const proof = await runReviewProofEval(db, repo, [{
      id: 'order-service-review-proof',
      title: 'Review OrderService listOrders behavior.',
      files: ['src/main/java/com/example/orders/OrderService.java'],
      symbols: ['OrderService.listOrders'],
      diff: [
        'diff --git a/src/main/java/com/example/orders/OrderService.java b/src/main/java/com/example/orders/OrderService.java',
        '--- a/src/main/java/com/example/orders/OrderService.java',
        '+++ b/src/main/java/com/example/orders/OrderService.java',
        '@@ -3,6 +3,7 @@ public class OrderService {',
        '     public String listOrders() {',
        '+        System.out.println("debug order list");',
        '         return "ok";',
        '     }',
      ].join('\n'),
      focus: 'bug-risk',
      baselineSearchTerms: ['OrderService', 'listOrders'],
      expectedContains: ['OrderService', 'System.out'],
      expectedFiles: ['OrderService.java'],
    }]);

    expect(proof.totals.tasks).toBe(1);
    expect(proof.totals.baselineCorrect).toBe(1);
    expect(proof.totals.mcpCorrect).toBe(1);
    expect(proof.totals.qualityMaintained).toBe(true);
    expect(proof.totals.baselineFilesOpened).toBeGreaterThan(proof.totals.mcpToolCalls);
    expect(proof.totals.inputTokenSavingPct).toBeGreaterThan(0);
    expect(proof.tasks[0]?.mcp.findingCount).toBeGreaterThan(0);
    expect(proof.tasks[0]?.mcp.changedFiles.some(file => file.endsWith('OrderService.java'))).toBe(true);
  });

  it('resolves Java parameter and local-variable receiver calls', async () => {
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

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const paymentCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'PaymentGateway.processPayment' },
    }) as { callers: Array<{ callee: string; resolution_kind: string }> };

    expect(paymentCallers.callers).toContainEqual(expect.objectContaining({
      callee: 'PaymentGateway.processPayment',
      resolution_kind: 'static-or-type-receiver',
    }));

    const refundCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'PaymentGateway.processRefund' },
    }) as { callers: Array<{ callee: string; resolution_kind: string }> };

    expect(refundCallers.callers).toContainEqual(expect.objectContaining({
      callee: 'PaymentGateway.processRefund',
      resolution_kind: 'static-or-type-receiver',
    }));

    const amountCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'PaymentInfo.getAmount' },
    }) as { callers: Array<{ callee: string; resolution_kind: string }> };

    expect(amountCallers.callers).toContainEqual(expect.objectContaining({
      callee: 'PaymentInfo.getAmount',
      resolution_kind: 'static-or-type-receiver',
    }));

    const implementationCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'InMemoryPaymentGateway.processPayment' },
    }) as { callers: Array<{ callee: string; resolution_kind: string }> };

    expect(implementationCallers.callers).toContainEqual(expect.objectContaining({
      callee: 'InMemoryPaymentGateway.processPayment',
      resolution_kind: 'interface-implementation',
    }));
  });

  it('warns about stale snapshots and can auto-refresh on query', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-stale-');
    writeFile(repo, 'src/main/java/com/example/Demo.java', `package com.example;

public class Demo {
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    writeFile(repo, 'src/main/java/com/example/Demo.java', `package com.example;

public class DemoChanged {
}
`);

    const queries = new V2QueryService(db);
    const staleSearch = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'Demo', limit: 5 },
    }) as { indexFreshness?: { isStale: boolean; dirtyFiles?: { modifiedCount: number } } };

    expect(staleSearch.indexFreshness?.isStale).toBe(true);
    expect(staleSearch.indexFreshness?.dirtyFiles?.modifiedCount).toBe(1);

    const refreshedSearch = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'DemoChanged', limit: 5, autoRefresh: true },
    }) as { symbols: Array<{ name: string }>; indexFreshness?: { isStale: boolean } };

    expect(refreshedSearch.symbols.some(symbol => symbol.name === 'DemoChanged')).toBe(true);
    expect(refreshedSearch.indexFreshness).toBeUndefined();
  });

  it('does not auto-refresh an empty first-time snapshot on query', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-empty-snapshot-');

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    expect(result.filesTotal).toBe(0);

    writeFile(repo, 'src/main/java/com/example/DemoLater.java', `package com.example;

public class DemoLater {
}
`);

    const queries = new V2QueryService(db);
    const search = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'DemoLater', limit: 5, autoRefresh: true },
    }) as { symbols: Array<{ name: string }>; indexFreshness?: { isStale: boolean } };

    expect(search.symbols.some(symbol => symbol.name === 'DemoLater')).toBe(false);
    expect(search.indexFreshness?.isStale).toBe(true);
  });

  it('skips inline auto-refresh when the indexed workspace exceeds the refresh file limit', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-large-refresh-');
    writeFile(repo, 'src/main/java/com/example/One.java', `package com.example;

public class One {
}
`);
    writeFile(repo, 'src/main/java/com/example/Two.java', `package com.example;

public class Two {
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    writeFile(repo, 'src/main/java/com/example/One.java', `package com.example;

public class OneChanged {
}
`);

    const previousLimit = process.env.CODEGRAPH_AUTO_REFRESH_FILE_LIMIT;
    process.env.CODEGRAPH_AUTO_REFRESH_FILE_LIMIT = '1';
    try {
      const queries = new V2QueryService(db);
      const search = await queries.query({
        workspaceId: result.workspaceId,
        toolName: 'search_symbol',
        args: { query: 'OneChanged', limit: 5, autoRefresh: true },
      }) as {
        symbols: Array<{ name: string }>;
        indexFreshness?: {
          isStale: boolean;
          autoRefreshSkipped?: {
            reason?: string;
            indexedFileCount?: number;
            autoRefreshFileLimit?: number;
          };
        };
      };

      expect(search.symbols.some(symbol => symbol.name === 'OneChanged')).toBe(false);
      expect(search.indexFreshness?.isStale).toBe(true);
      expect(search.indexFreshness?.autoRefreshSkipped).toMatchObject({
        reason: 'indexed-file-count-exceeds-auto-refresh-limit',
        indexedFileCount: 2,
        autoRefreshFileLimit: 1,
      });
    } finally {
      if (previousLimit === undefined) {
        delete process.env.CODEGRAPH_AUTO_REFRESH_FILE_LIMIT;
      } else {
        process.env.CODEGRAPH_AUTO_REFRESH_FILE_LIMIT = previousLimit;
      }
    }
  });

  it('uses workspace keys to distinguish Docker-mounted repositories with the same container root', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-workspace-key-');
    writeFile(repo, 'src/main/java/com/example/Demo.java', `package com.example;

public class Demo {
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const first = await indexer.indexWorkspace({ root: repo, workspaceKey: 'C:/repos/app-main' });
    const same = await indexer.indexWorkspace({ root: repo, workspaceKey: 'c:/repos/app-main' });
    const second = await indexer.indexWorkspace({ root: repo, workspaceKey: 'C:/repos/app-feature' });

    expect(same.workspaceId).toBe(first.workspaceId);
    expect(second.workspaceId).not.toBe(first.workspaceId);
  });

  it('refreshes after git checkout when autoRefresh is enabled', async () => {
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

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo, workspaceKey: 'checkout-same-folder' });
    const queries = new V2QueryService(db);

    const mainSearch = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'MainBranchMarker', limit: 5 },
    }) as { symbols: Array<{ name: string }> };
    expect(mainSearch.symbols.some(symbol => symbol.name === 'MainBranchMarker')).toBe(true);

    runGit(repo, 'checkout', 'feature');

    const staleFeatureSearch = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'FeatureBranchMarker', limit: 5 },
    }) as { indexFreshness?: { isStale: boolean; dirtyFiles?: unknown } };

    expect(staleFeatureSearch.indexFreshness?.isStale).toBe(true);
    expect(staleFeatureSearch.indexFreshness?.dirtyFiles).toBeUndefined();

    const featureSearch = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'FeatureBranchMarker', limit: 5, autoRefresh: true },
    }) as { symbols: Array<{ name: string }>; indexFreshness?: { isStale: boolean } };

    expect(featureSearch.symbols.some(symbol => symbol.name === 'FeatureBranchMarker')).toBe(true);
    expect(featureSearch.indexFreshness).toBeUndefined();
  });

  it('reuses parse cache on a second snapshot', async () => {
    const home = tempDir('codegraph-home-');
    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const first = await indexer.indexWorkspace({ root: JAVA_FIXTURE });
    const second = await indexer.indexWorkspace({ root: JAVA_FIXTURE });

    expect(first.filesParsed).toBeGreaterThan(0);
    expect(second.parseCacheHits).toBeGreaterThan(0);
    expect(second.filesParsed).toBe(0);
    expect(second.filesHashed).toBe(0);
    expect(second.hashCacheHits).toBe(second.filesTotal);
    expect(second.skippedUnchanged).toBe(true);
  });

  it('updates small changed-file indexes in place', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-incremental-');
    writeFile(repo, 'src/main/java/com/example/Feature.java', `package com.example;

public class OriginalFeature {
}
`);
    writeFile(repo, 'src/main/java/com/example/Keep.java', `package com.example;

public class Keep {
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const first = await indexer.indexWorkspace({ root: repo });

    writeFile(repo, 'src/main/java/com/example/Feature.java', `package com.example;

public class ChangedFeature {
}
`);
    const second = await indexer.indexWorkspace({ root: repo });

    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.incrementalUpdated).toBe(true);
    expect(second.filesChanged).toBe(1);
    expect(second.filesDeleted).toBe(0);
    expect(second.filesParsed).toBe(1);
    expect(second.hashCacheHits).toBeGreaterThan(0);

    const queries = new V2QueryService(db);
    const changedSearch = await queries.query({
      workspaceId: second.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'ChangedFeature', limit: 5 },
    }) as { symbols: Array<{ name: string }> };
    expect(changedSearch.symbols.some(symbol => symbol.name === 'ChangedFeature')).toBe(true);

    const originalSearch = await queries.query({
      workspaceId: second.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'OriginalFeature', limit: 5 },
    }) as { symbols: Array<{ name: string }> };
    expect(originalSearch.symbols.some(symbol => symbol.name === 'OriginalFeature')).toBe(false);

    fs.rmSync(path.join(repo, 'src/main/java/com/example/Keep.java'));
    const third = await indexer.indexWorkspace({ root: repo });
    expect(third.snapshotId).toBe(first.snapshotId);
    expect(third.incrementalUpdated).toBe(true);
    expect(third.filesDeleted).toBe(1);

    const deletedSearch = await queries.query({
      workspaceId: third.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'Keep', limit: 5 },
    }) as { symbols: Array<{ name: string }> };
    expect(deletedSearch.symbols.some(symbol => symbol.name === 'Keep')).toBe(false);
  });

  it('discovers synthetic Jakarta endpoints', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-synthetic-');
    generateSyntheticJavaRepo({ root: repo, files: 40, modules: 2 });

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);
    const endpoints = await queries.query({
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

async function openDb(home: string): Promise<{ db: CodeGraphDb }> {
  const opened = await openCodeGraphDb(home);
  dbs.push(opened.db);
  return opened;
}

async function resetDb(db: CodeGraphDb): Promise<void> {
  await db.run(`
    TRUNCATE TABLE
      workspaces,
      snapshots,
      files,
      parse_cache,
      symbols,
      imports,
      type_refs,
      call_edges,
      dependency_edges,
      annotations,
      endpoints,
      beans,
      inheritance
    RESTART IDENTITY CASCADE
  `);
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
