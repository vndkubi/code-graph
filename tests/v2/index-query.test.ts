import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodeGraphDb } from '../../src/v2/storage/database.js';
import { openCodeGraphDb } from '../../src/v2/storage/database.js';
import { V2Indexer, type IndexProgressEvent } from '../../src/v2/index/indexer.js';
import { V2QueryService } from '../../src/v2/query/service.js';
import { parseFilesBatchToSpool, readParseContextItemsJsonl, type ParseWorkItem } from '../../src/v2/index/parse.js';
import { generateSyntheticJavaRepo } from '../../src/v2/benchmark/synthetic-java.js';
import { runContextProofEval } from '../../src/v2/benchmark/context-proof.js';
import { runReviewProofEval } from '../../src/v2/benchmark/review-proof.js';
import { parseCodexJsonEvents, scoreCodexOutput } from '../../src/v2/benchmark/codex-e2e.js';
import { buildGraphExport, renderGraphHtml } from '../../src/v2/graph/export.js';
import { rebuildGraphOverlay } from '../../src/v2/graph/overlay.js';
import { buildV2ToolDefinitions, mcpToolNamesForProfile, V2_TOOL_DEFINITIONS, V2_TOOL_PROFILES } from '../../src/v2/mcp/tools.js';

const tempDirs: string[] = [];
const dbs: CodeGraphDb[] = [];
const JAVA_FIXTURE = path.resolve('tests/fixtures/java-project');

afterEach(async () => {
  for (const db of dbs.splice(0)) {
    await db.close();
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('v2 SQLite index and query service', () => {
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

  it('keeps low-signal call edges in the raw index but hides them by default', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-call-signal-');
    writeFile(repo, 'src/main/java/com/example/PaymentGateway.java', `package com.example;

public class PaymentGateway {
    public boolean processPayment() {
        return true;
    }
}
`);
    writeFile(repo, 'src/main/java/com/example/NoiseService.java', `package com.example;

public class NoiseService {
    public void execute(PaymentGateway gateway) {
        gateway.processPayment();
        assertThat(gateway);
        mock();
        when(gateway.processPayment());
    }
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const lowSignalRows = await db.prepare(`
      SELECT callee, signal_tier, signal_reasons_json, confidence
      FROM call_edges
      WHERE snapshot_id = ? AND callee IN ('assertThat', 'mock', 'when')
      ORDER BY callee
    `).all(result.snapshotId) as Array<{ callee: string; signal_tier: string; signal_reasons_json: string; confidence: number }>;
    expect(lowSignalRows.map(row => row.callee)).toEqual(['assertThat', 'mock', 'when']);
    expect(lowSignalRows.every(row => row.signal_tier === 'low_signal')).toBe(true);
    expect(lowSignalRows.every(row => row.signal_reasons_json.includes('low-signal unqualified helper call'))).toBe(true);
    expect(lowSignalRows.every(row => row.confidence <= 0.25)).toBe(true);

    const defaultCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'assertThat' },
    }) as { callers: Array<{ callee: string }> };
    expect(defaultCallers.callers).toHaveLength(0);

    const deepCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'assertThat', includeLowSignal: true },
    }) as { callers: Array<{ callee: string; signal_tier: string }> };
    expect(deepCallers.callers).toContainEqual(expect.objectContaining({
      callee: 'assertThat',
      signal_tier: 'low_signal',
    }));

    const primaryCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'PaymentGateway.processPayment' },
    }) as { callers: Array<{ callee: string; signal_tier: string }> };
    expect(primaryCallers.callers).toContainEqual(expect.objectContaining({
      callee: 'PaymentGateway.processPayment',
      signal_tier: 'primary',
    }));

    const stats = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_index_stats',
      args: { warnStale: false },
    }) as { counts: { callEdgesRaw: number; callEdgesPrimary: number; callEdgesLowSignal: number } };
    expect(stats.counts.callEdgesLowSignal).toBe(3);
    expect(stats.counts.callEdgesRaw).toBeGreaterThan(stats.counts.callEdgesPrimary);
  });

  it('indexes Java field usages for references, change packs, review packets, and warm cache reuse', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-field-usage-');
    writeFile(repo, 'src/main/java/com/example/FieldImpactSubject.java', `package com.example;

public class FieldImpactSubject {
    private int fieldA;
    private Helper helper;

    public FieldImpactSubject(int fieldA, Helper helper) {
        this.fieldA = fieldA;
        this.helper = helper;
    }

    public void update() {
        fieldA++;
        this.fieldA += 2;
        helper.touch();
    }

    public int read() {
        return this.fieldA + fieldA;
    }

    public void shadow(int fieldA) {
        fieldA = fieldA + 1;
    }

    public void typed(Holder holder) {
        holder.fieldA = this.fieldA;
    }
}

class Helper {
    void touch() {}
}

class Holder {
    public int fieldA;
}
`);
    writeFile(repo, 'src/test/java/com/example/FieldImpactSubjectTest.java', `package com.example;

public class FieldImpactSubjectTest {
    public void updateUsesFieldA() {
        new FieldImpactSubject(1, new Helper()).update();
    }
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const first = await indexer.indexWorkspace({ root: repo, workspaceKey: 'field-impact-first' });
    expect(first.indexProviderVersions['tree-sitter']).toContain('default-field-usages');
    const queries = new V2QueryService(db);

    const rows = await db.prepare(`
      SELECT field_name, owner_class, access_kind, enclosing_symbol, resolution_kind
      FROM field_usages
      WHERE snapshot_id = ? AND field_name = 'fieldA'
      ORDER BY line, access_kind
    `).all(first.snapshotId) as Array<{
      field_name: string;
      owner_class?: string;
      access_kind: string;
      enclosing_symbol?: string;
      resolution_kind: string;
    }>;
    expect(rows.some(row => row.access_kind === 'init' && row.resolution_kind === 'this-field')).toBe(true);
    expect(rows.some(row => row.access_kind === 'read_write' && row.enclosing_symbol === 'FieldImpactSubject.update')).toBe(true);
    expect(rows.some(row => row.access_kind === 'read' && row.enclosing_symbol === 'FieldImpactSubject.read')).toBe(true);
    expect(rows.some(row => row.owner_class === 'Holder' && row.resolution_kind === 'receiver-type-field')).toBe(true);
    expect(rows.some(row => row.enclosing_symbol === 'FieldImpactSubject.shadow')).toBe(false);

    const references = await queries.query({
      workspaceId: first.workspaceId,
      toolName: 'find_references',
      args: { symbol: 'fieldA', kind: 'field_usage', groupBy: 'method', limit: 20 },
    }) as {
      references: Array<{ kind: string; fieldAccess: string; enclosingSymbol: string; resolutionKind: string }>;
      groups: Array<{ key: string; count: number }>;
    };
    expect(references.references).toContainEqual(expect.objectContaining({
      kind: 'field_usage',
      fieldAccess: 'init',
      enclosingSymbol: 'FieldImpactSubject.FieldImpactSubject',
    }));
    expect(references.references).toContainEqual(expect.objectContaining({
      fieldAccess: 'read_write',
      enclosingSymbol: 'FieldImpactSubject.update',
    }));
    expect(references.groups.some(group => group.key === 'FieldImpactSubject.update')).toBe(true);

    const changePack = await queries.query({
      workspaceId: first.workspaceId,
      toolName: 'get_change_pack',
      args: { task: 'investigate changing fieldA logic', profile: 'compact' },
    }) as { fieldImpact?: { usageCount?: number; groups?: { byMethod?: Array<{ key: string }> } } };
    expect(Number(changePack.fieldImpact?.usageCount ?? 0)).toBeGreaterThan(0);
    expect(changePack.fieldImpact?.groups?.byMethod?.some(group => group.key === 'FieldImpactSubject.update')).toBe(true);

    const review = await queries.query({
      workspaceId: first.workspaceId,
      toolName: 'review_patch',
      args: {
        diff: `diff --git a/src/main/java/com/example/FieldImpactSubject.java b/src/main/java/com/example/FieldImpactSubject.java
@@ -9,7 +9,7 @@ public class FieldImpactSubject {
-        this.fieldA = fieldA;
+        this.fieldA = fieldA + 1;
`,
      },
    }) as { fieldImpact?: { usageCount?: number } };
    expect(Number(review.fieldImpact?.usageCount ?? 0)).toBeGreaterThan(0);

    const second = await indexer.indexWorkspace({ root: repo, workspaceKey: 'field-impact-second' });
    expect(second.parseCacheHits).toBeGreaterThan(0);
    const warmRows = await db.prepare(`
      SELECT COUNT(*) AS count
      FROM field_usages
      WHERE snapshot_id = ? AND field_name = 'fieldA'
    `).get(second.snapshotId) as { count: number | string } | undefined;
    expect(Number(warmRows?.count ?? 0)).toBeGreaterThan(0);
  });

  it('can explicitly disable Java field usage facts for colder large-repo runs', async () => {
    const previousFieldUsageFlag = process.env.CODEGRAPH_ENABLE_FIELD_USAGES;
    process.env.CODEGRAPH_ENABLE_FIELD_USAGES = '0';
    try {
      const home = tempDir('codegraph-home-');
      const repo = tempDir('codegraph-field-usage-disabled-');
      writeFile(repo, 'src/main/java/com/example/FieldImpactSubject.java', `package com.example;

public class FieldImpactSubject {
    private int fieldA;

    public void update() {
        fieldA++;
    }
}
`);

      const { db } = await openDb(home);
      const indexer = new V2Indexer(db);
      const result = await indexer.indexWorkspace({ root: repo });
      expect(result.indexProviderVersions['tree-sitter']).toContain('field-usages-disabled');

      const row = await db.prepare(`
        SELECT COUNT(*) AS count FROM field_usages WHERE snapshot_id = ?
      `).get(result.snapshotId) as { count: number | string };
      expect(Number(row.count)).toBe(0);
    } finally {
      if (previousFieldUsageFlag === undefined) delete process.env.CODEGRAPH_ENABLE_FIELD_USAGES;
      else process.env.CODEGRAPH_ENABLE_FIELD_USAGES = previousFieldUsageFlag;
    }
  });

  it('reports unresolved imports without loading all symbol/import rows in the query process', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-unresolved-imports-');
    writeFile(repo, 'src/main/java/com/example/KnownType.java', `package com.example;

public class KnownType {
}
`);
    writeFile(repo, 'src/main/java/com/example/UsesImports.java', `package com.example;

import com.example.KnownType;
import com.example.DoesNotExist;
import java.util.List;
import org.springframework.stereotype.Service;

public class UsesImports {
    private KnownType known;
    private DoesNotExist missing;
    private List<String> values;
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const stats = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_index_stats',
      args: { warnStale: false },
    }) as { diagnostics: { topUnresolvedImports: Array<{ source: string; count: number }> } };
    const sources = stats.diagnostics.topUnresolvedImports.map(row => row.source);

    expect(stats.diagnostics.topUnresolvedImports).toContainEqual({ source: 'com.example.DoesNotExist', count: 1 });
    expect(sources).not.toContain('com.example.KnownType');
    expect(sources).not.toContain('java.util.List');
    expect(sources).not.toContain('org.springframework.stereotype.Service');
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

  it('rescues exact test symbols from broad search windows and links receiver-field calls', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-exact-test-symbol-');
    const noiseMethods = Array.from({ length: 650 }, (_, i) => `
    public void federationInterceptorRESTNoise${i}() {
    }
`).join('');
    writeFile(repo, 'src/main/java/org/apache/hadoop/yarn/server/router/webapp/FederationRESTNoise.java', `package org.apache.hadoop.yarn.server.router.webapp;

public class FederationRESTNoise {
${noiseMethods}
}
`);
    writeFile(repo, 'src/main/java/org/apache/hadoop/yarn/server/router/webapp/FederationInterceptorREST.java', `package org.apache.hadoop.yarn.server.router.webapp;

public class FederationInterceptorREST {
}
`);
    writeFile(repo, 'src/test/java/org/apache/hadoop/yarn/server/router/webapp/TestableFederationInterceptorREST.java', `package org.apache.hadoop.yarn.server.router.webapp;

public class TestableFederationInterceptorREST extends FederationInterceptorREST {
    public void setupResourceManager() {
    }
}
`);
    writeFile(repo, 'src/test/java/org/apache/hadoop/yarn/server/router/webapp/TestFederationInterceptorREST.java', `package org.apache.hadoop.yarn.server.router.webapp;

public class TestFederationInterceptorREST {
    private TestableFederationInterceptorREST interceptor;

    public void setUp() {
        interceptor = new TestableFederationInterceptorREST();
        interceptor.setupResourceManager();
    }
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const search = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'TestableFederationInterceptorREST', kind: 'class', limit: 5, explainRank: true },
    }) as {
      filters: { includeTests?: boolean };
      symbols: Array<{
        name: string;
        file: string;
        fileRole: string;
        matchReason: string;
        rankExplanation: string[];
      }>;
    };

    expect(search.filters.includeTests).toBe(true);
    expect(search.symbols[0]).toMatchObject({
      name: 'TestableFederationInterceptorREST',
      fileRole: 'test_source',
      file: 'src/test/java/org/apache/hadoop/yarn/server/router/webapp/TestableFederationInterceptorREST.java',
      matchReason: 'exact symbol/FQCN match',
    });
    expect(search.symbols[0]?.rankExplanation).toContain('exact symbol or FQCN equals query');

    const callers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'TestableFederationInterceptorREST.setupResourceManager', limit: 10 },
    }) as {
      callers: Array<{ caller: string; callee: string; file: string; resolution_kind: string }>;
    };
    expect(callers.callers).toContainEqual(expect.objectContaining({
      caller: 'TestFederationInterceptorREST.setUp',
      callee: 'TestableFederationInterceptorREST.setupResourceManager',
      file: 'src/test/java/org/apache/hadoop/yarn/server/router/webapp/TestFederationInterceptorREST.java',
      resolution_kind: 'receiver-field',
    }));
  });

  it('indexes large Java source files without parser buffer failures', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-large-java-');
    const padding = `/*
${'large java source padding\n'.repeat(6000)}
*/`;
    writeFile(repo, 'src/main/java/com/example/LargeService.java', `package com.example;

${padding}
public class LargeService {
    public void execute() {
    }
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const fileRow = await db.prepare(`
      SELECT parse_status
      FROM files
      WHERE snapshot_id = ? AND path = ?
    `).get(result.snapshotId, 'src/main/java/com/example/LargeService.java') as { parse_status?: string } | undefined;
    expect(fileRow?.parse_status).toBe('ok');

    const search = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'LargeService', kind: 'class', limit: 5 },
    }) as { symbols: Array<{ name: string; file: string }> };
    expect(search.symbols).toContainEqual(expect.objectContaining({
      name: 'LargeService',
      file: 'src/main/java/com/example/LargeService.java',
    }));
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

  it('resolves JAX-RS endpoint paths from sibling Java constants', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-jaxrs-constant-endpoints-');
    writeFile(repo, 'src/main/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/RMWSConsts.java', `package org.apache.hadoop.yarn.server.resourcemanager.webapp;

public final class RMWSConsts {
    public static final String RM_WEB_SERVICE_PATH = "/ws/v1/cluster";
    public static final String APPS = "/apps";
}
`);
    writeFile(repo, 'src/main/java/org/apache/hadoop/yarn/server/resourcemanager/webapp/RMWebServices.java', `package org.apache.hadoop.yarn.server.resourcemanager.webapp;

import javax.ws.rs.GET;
import javax.ws.rs.Path;

@Path(RMWSConsts.RM_WEB_SERVICE_PATH)
public class RMWebServices {
    @GET
    @Path(RMWSConsts.APPS)
    public AppsInfo getApps() {
        return new AppsInfo();
    }
}

class AppsInfo {
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const endpoints = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'find_endpoints',
      args: { method: 'GET', path: '/ws/v1/cluster/apps', explainRank: true },
    }) as { endpoints: Array<{ path: string; pathResolution: string; handlerSymbol: string }> };

    expect(endpoints.endpoints[0]).toMatchObject({
      path: '/ws/v1/cluster/apps',
      pathResolution: 'exact',
      handlerSymbol: 'org.apache.hadoop.yarn.server.resourcemanager.webapp.RMWebServices.getApps()',
    });

    const explanation = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'explain_endpoint',
      args: { method: 'GET', path: '/ws/v1/cluster/apps' },
    }) as { endpoint?: { path: string; pathResolution: string }; error?: string };

    expect(explanation.error).toBeUndefined();
    expect(explanation.endpoint).toMatchObject({
      path: '/ws/v1/cluster/apps',
      pathResolution: 'exact',
    });
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

    const cappedMixed = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_code',
      args: {
        query: 'PaymentService',
        outputMode: 'full',
        limit: 50,
        maxResponseTokens: 500,
      },
    }) as {
      outputMode: string;
      sections: {
        files: { files: unknown[] };
        symbols: { symbols: unknown[] };
      };
      budget: {
        responseCap: {
          maxResponseTokens: number;
          capped: boolean;
          estimatedResponseTokens: number;
          estimatedFullResponseTokens: number;
          estimatedTokensSaved: number;
        };
      };
    };

    expect(cappedMixed.outputMode).toBe('compact-capped');
    expect(cappedMixed.sections.files.files.length).toBeGreaterThan(0);
    expect(cappedMixed.sections.symbols.symbols.length).toBeGreaterThan(0);
    expect(cappedMixed.budget.responseCap.maxResponseTokens).toBe(500);
    expect(cappedMixed.budget.responseCap.capped).toBe(true);
    expect(cappedMixed.budget.responseCap.estimatedFullResponseTokens)
      .toBeGreaterThan(cappedMixed.budget.responseCap.estimatedResponseTokens);
    expect(cappedMixed.budget.responseCap.estimatedTokensSaved).toBeGreaterThan(0);
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
      taskOracle: {
        successCriteria: string[];
        expectedVerification: { commands: string[]; targetedTestFiles: string[]; redGreenRequired: boolean };
        likelyTests: Array<{ file: string }>;
        goldenFacts: Array<{ kind: string; value?: string; file?: string }>;
      };
      sliceHints: Array<{ file: string; lines?: string; symbol?: string }>;
      toolHints: Array<{ tool: string; args: { slices?: Array<{ file?: string; lines?: string; symbol?: string }> } }>;
      nextAction: string;
      budget: {
        requestedTokenBudget: number;
        estimatedResponseTokens: number;
        estimatedFullResponseTokens: number;
        estimatedTokensSaved: number;
        evidenceHandleCount: number;
        capExceeded: boolean;
      };
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
    expect(packet.taskOracle.expectedVerification.targetedTestFiles.some(file => file.endsWith('PaymentServiceTest.java'))).toBe(true);
    expect(packet.taskOracle.likelyTests.some(test => test.file.endsWith('PaymentServiceTest.java'))).toBe(true);
    expect(packet.taskOracle.successCriteria.join(' ')).toContain('source-of-truth');
    expect(packet.taskOracle.goldenFacts.some(fact => String(fact.value ?? fact.file).includes('PaymentService'))).toBe(true);
    expect(packet.sliceHints.some(hint => hint.file.endsWith('PaymentService.java'))).toBe(true);
    expect(packet.toolHints.some(hint => hint.tool === 'get_file_slice' && Array.isArray(hint.args.slices))).toBe(true);
    expect(packet.nextAction).toContain('get_file_slice');
    expect(packet.budget.requestedTokenBudget).toBe(4000);
    expect(packet.budget.estimatedResponseTokens).toBeGreaterThan(0);
    expect(packet.budget.estimatedFullResponseTokens).toBeGreaterThanOrEqual(packet.budget.estimatedResponseTokens);
    expect(packet.budget.estimatedTokensSaved).toBeGreaterThanOrEqual(0);
    expect(packet.budget.evidenceHandleCount).toBe(packet.sliceHints.length);
    expect(packet.budget.capExceeded).toBe(packet.budget.estimatedResponseTokens > packet.budget.requestedTokenBudget);

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

    const batchSlice = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_file_slice',
      args: {
        maxChars: 1000,
        slices: [
          { symbol: 'PaymentService.refund' },
          { file: 'src/main/java/com/example/payment/PaymentGateway.java', lines: '1-4', maxChars: 600 },
        ],
      },
    }) as { batch: boolean; slices: Array<{ file: string; text?: string; error?: string }>; returnedCount: number };

    expect(batchSlice.batch).toBe(true);
    expect(batchSlice.returnedCount).toBe(2);
    expect(batchSlice.slices[0]?.text).toContain('processRefund');
    expect(batchSlice.slices[1]?.text).toContain('PaymentGateway');

    const changePack = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_change_pack',
      args: {
        task: 'debug duplicate refund timeout in PaymentService.refund',
        changeType: 'debug',
        maxFiles: 4,
        maxSymbols: 6,
        tokenBudget: 4000,
      },
    }) as {
      files: Array<{ file: string }>;
      symbols: Array<{ symbol: string }>;
      editRanges: Array<{ file?: string; lines?: string; symbol?: string }>;
      testsLikelyRelevant: Array<{ file: string }>;
      invariants: string[];
      expectedVerification: { targetedTestFiles?: string[]; redGreenRequired?: boolean };
      taskOracle: { goldenFacts: Array<{ value?: string; file?: string }> };
      routing: { firstToolCall?: { tool: string } };
    };

    expect(changePack.files.some(file => file.file.endsWith('PaymentService.java'))).toBe(true);
    expect(changePack.symbols.some(symbol => symbol.symbol.includes('PaymentService'))).toBe(true);
    expect(changePack.editRanges.some(range => range.file?.endsWith('PaymentService.java') || range.symbol?.includes('PaymentService'))).toBe(true);
    expect(changePack.testsLikelyRelevant.some(test => test.file.endsWith('PaymentServiceTest.java'))).toBe(true);
    expect(changePack.invariants.some(invariant => invariant.includes('red-to-green'))).toBe(true);
    expect(changePack.expectedVerification.redGreenRequired).toBe(true);
    expect(changePack.routing.firstToolCall?.tool).toBe('get_file_slice');

    const microChangePack = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_change_pack',
      args: {
        task: 'debug duplicate refund timeout in PaymentService.refund',
        changeType: 'debug',
        profile: 'micro',
        maxFiles: 10,
        maxSymbols: 20,
        tokenBudget: 12000,
      },
    }) as {
      files: Array<{ file: string }>;
      symbols: Array<{ symbol: string }>;
      editRanges: Array<{ file?: string; lines?: string; symbol?: string }>;
      testsLikelyRelevant: Array<{ file: string }>;
      budget: {
        profile: string;
        tokenBudget: number;
        requestedTokenBudget: number;
        estimatedResponseTokens: number;
        evidenceHandleCount: number;
        capExceeded: boolean;
      };
    };

    expect(microChangePack.budget.profile).toBe('micro');
    expect(microChangePack.budget.tokenBudget).toBe(3000);
    expect(microChangePack.budget.requestedTokenBudget).toBe(3000);
    expect(microChangePack.budget.evidenceHandleCount).toBeGreaterThanOrEqual(microChangePack.editRanges.length);
    expect(microChangePack.budget.capExceeded)
      .toBe(microChangePack.budget.estimatedResponseTokens > microChangePack.budget.requestedTokenBudget);
    expect(microChangePack.files.length).toBeLessThanOrEqual(4);
    expect(microChangePack.symbols.length).toBeLessThanOrEqual(6);
    expect(microChangePack.editRanges.length).toBeLessThanOrEqual(4);
    expect(microChangePack.testsLikelyRelevant.length).toBeLessThanOrEqual(4);
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
      profile: string;
      evidenceSlices: Array<{ file: string; text: string; lines: string }>;
      evidenceHandles: Array<{ tool: string; args: { file?: string; lines?: string; symbol?: string; maxChars?: number } }>;
      completeness: { sufficientForAnswer: boolean; evidenceSliceCount: number };
      answerGuidance: string[];
      nextAction: string;
      definitionCandidates: Array<{ symbol: string; file: string }>;
      flowSteps: unknown[];
      taskOracle: {
        successCriteria: string[];
        expectedVerification: { fallback: string };
        goldenFacts: Array<{ kind: string; value?: string; file?: string }>;
      };
      compressedEvidence: {
        factCards: Array<{ kind: string; subject?: string; file?: string }>;
        callGraphEdges: Array<{ caller?: string; callee?: string }>;
        sourceSliceRefs: Array<{ file?: string; textPreview?: string }>;
        compressionRatio: number;
      };
      budget: {
        profile: string;
        requestedTokenBudget: number;
        estimatedResponseTokens: number;
        estimatedFullResponseTokens: number;
        estimatedTokensSaved: number;
        handleCount: number;
        evidenceHandleCount: number;
        capExceeded: boolean;
      };
    };

    expect(researchPack.profile).toBe('compact');
    expect(researchPack.completeness.sufficientForAnswer).toBe(true);
    expect(researchPack.completeness.evidenceSliceCount).toBeGreaterThan(0);
    expect(researchPack.definitionCandidates.some(symbol => symbol.symbol.includes('PaymentService'))).toBe(true);
    expect(researchPack.evidenceSlices.some(slice => slice.file.endsWith('PaymentService.java'))).toBe(true);
    expect(researchPack.evidenceSlices.some(slice => slice.text.includes('processRefund'))).toBe(true);
    expect(researchPack.evidenceHandles.some(handle => handle.tool === 'get_file_slice' && handle.args.file?.endsWith('PaymentService.java'))).toBe(true);
    expect(researchPack.budget.profile).toBe('compact');
    expect(researchPack.budget.requestedTokenBudget).toBe(5000);
    expect(researchPack.budget.estimatedResponseTokens).toBeGreaterThan(0);
    expect(researchPack.budget.estimatedFullResponseTokens).toBeGreaterThanOrEqual(researchPack.budget.estimatedResponseTokens);
    expect(researchPack.budget.handleCount).toBe(researchPack.evidenceHandles.length);
    expect(researchPack.budget.evidenceHandleCount).toBe(researchPack.evidenceHandles.length);
    expect(researchPack.budget.capExceeded).toBe(researchPack.budget.estimatedResponseTokens > researchPack.budget.requestedTokenBudget);
    expect(researchPack.answerGuidance.join(' ')).toContain('Answer directly');
    expect(researchPack.nextAction).toContain('Answer');
    expect(researchPack.flowSteps.length).toBeGreaterThan(0);
    expect(researchPack.taskOracle.successCriteria.join(' ')).toContain('file and line evidence');
    expect(researchPack.taskOracle.goldenFacts.some(fact => String(fact.value ?? fact.file).includes('PaymentService'))).toBe(true);
    expect(researchPack.compressedEvidence.factCards.some(card => String(card.subject ?? card.file).includes('PaymentService'))).toBe(true);
    expect(researchPack.compressedEvidence.sourceSliceRefs.some(slice => slice.file?.endsWith('PaymentService.java'))).toBe(true);
    expect(researchPack.compressedEvidence.compressionRatio).toBeLessThan(1);

    const flowPack = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_flow_pack',
      args: {
        target: 'PaymentService refund flow',
        tokenBudget: 5000,
      },
    }) as {
      taskType: string;
      responseMode: string;
      profile: string;
      routing: { answerDirectly: boolean };
      evidenceSlices: Array<{ text: string }>;
      evidenceHandles: Array<{ tool: string }>;
      compressedEvidence: { factCards: unknown[] };
      taskOracle: { goldenFacts: unknown[] };
    };

    expect(flowPack.taskType).toBe('architecture');
    expect(flowPack.responseMode).toBe('agent');
    expect(flowPack.profile).toBe('compact');
    expect(flowPack.routing.answerDirectly).toBe(true);
    expect(flowPack.evidenceSlices.some(slice => slice.text.includes('processRefund'))).toBe(true);
    expect(flowPack.evidenceHandles.some(handle => handle.tool === 'get_file_slice')).toBe(true);
    expect(flowPack.taskOracle.goldenFacts.length).toBeGreaterThan(0);
    expect(flowPack.compressedEvidence.factCards.length).toBeGreaterThan(0);

    const flowAnswerPack = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_flow_pack',
      args: {
        target: 'PaymentService refund flow',
        tokenBudget: 5000,
        responseMode: 'answer',
      },
    }) as {
      responseMode: string;
      evidenceSlices: Array<{ text: string }>;
      evidenceHandles?: Array<{ tool: string }>;
      compressedEvidence?: unknown;
      taskOracle?: unknown;
      budget: { requestedTokenBudget: number; estimatedResponseTokens: number; estimatedFullResponseTokens: number; capExceeded: boolean };
    };

    expect(flowAnswerPack.responseMode).toBe('answer');
    expect(flowAnswerPack.evidenceSlices.some(slice => slice.text.includes('processRefund'))).toBe(true);
    expect(flowAnswerPack.evidenceHandles).toBeUndefined();
    expect(flowAnswerPack.compressedEvidence).toBeUndefined();
    expect(flowAnswerPack.taskOracle).toBeUndefined();
    expect(flowAnswerPack.budget.requestedTokenBudget).toBe(5000);
    expect(flowAnswerPack.budget.estimatedFullResponseTokens).toBeGreaterThan(flowAnswerPack.budget.estimatedResponseTokens);
    expect(flowAnswerPack.budget.capExceeded).toBe(flowAnswerPack.budget.estimatedResponseTokens > flowAnswerPack.budget.requestedTokenBudget);

    const compiled = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'compile_evidence',
      args: {
        task: 'Trace how PaymentService refund calls PaymentGateway processRefund and answer with evidence.',
        task_type: 'api_flow',
        budget_tokens: 5000,
        quality_rubric: ['definitions', 'flow', 'evidence'],
      },
    }) as {
      sourceTool: string;
      answerable: boolean;
      recommendedNextAction: string;
      maxAdditionalCalls: number;
      coverage: Record<string, { status: string; evidence: string[] }>;
      coverageCertificate: { answerability: string; missing: string[] };
      evidence: Array<{ id: string; file?: string; symbol?: string; snippet?: string; sourceTool: string }>;
      disallowedFollowups: string[];
      gatePolicy: { whenAnswerable: string; denyMessage: string };
      budget: {
        requestedTokenBudget: number;
        estimatedResponseTokens: number;
        estimatedFullResponseTokens: number;
        evidenceHandleCount: number;
        capExceeded: boolean;
        sourceTool: string;
      };
    };

    expect(compiled.sourceTool).toBe('get_research_pack');
    expect(compiled.answerable).toBe(true);
    expect(compiled.recommendedNextAction).toBe('answer_now');
    expect(compiled.maxAdditionalCalls).toBe(0);
    expect(compiled.coverage.definitions.status).toBe('covered');
    expect(compiled.coverage.flow.status).toBe('covered');
    expect(compiled.coverage.evidence.status).toBe('covered');
    expect(compiled.coverageCertificate.missing).toHaveLength(0);
    expect(compiled.evidence.some(item => item.id === 'E1')).toBe(true);
    expect(compiled.evidence.some(item => item.file?.endsWith('PaymentService.java') && item.snippet?.includes('processRefund'))).toBe(true);
    expect(compiled.disallowedFollowups).toContain('shell_rg');
    expect(compiled.gatePolicy.whenAnswerable).toContain('deny broad shell');
    expect(compiled.budget.requestedTokenBudget).toBe(5000);
    expect(compiled.budget.estimatedFullResponseTokens).toBeGreaterThanOrEqual(compiled.budget.estimatedResponseTokens);
    expect(compiled.budget.sourceTool).toBe('get_research_pack');
  });

  it('promotes endpoint targets into flow pack handler evidence and callees', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-endpoint-flow-pack-');
    writeFile(repo, 'src/main/java/com/example/api/OrderResource.java', `package com.example.api;

import javax.ws.rs.GET;
import javax.ws.rs.Path;

@Path("/api")
public class OrderResource {
    private final OrderService service = new OrderService();

    @GET
    @Path("/orders")
    public String listOrders() {
        return service.listOrders();
    }
}
`);
    writeFile(repo, 'src/main/java/com/example/api/OrderService.java', `package com.example.api;

public class OrderService {
    public String listOrders() {
        return "ok";
    }
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const flowPack = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_flow_pack',
      args: {
        target: 'For API GET /api/orders, what logic and method does it call?',
        profile: 'full',
        tokenBudget: 6000,
        includeLowSignal: true,
      },
    }) as {
      definitionCandidates: Array<{ symbol: string; frameworkRole?: string }>;
      impactedEndpoints: Array<{ method: string; path: string; handlerSymbol: string }>;
      evidenceSlices: Array<{ file: string; text: string }>;
      callees: Array<{ callee: string }>;
      routing: { answerDirectly: boolean };
    };

    expect(flowPack.routing.answerDirectly).toBe(true);
    expect(flowPack.impactedEndpoints).toContainEqual(expect.objectContaining({
      method: 'GET',
      path: '/api/orders',
      handlerSymbol: expect.stringContaining('OrderResource.listOrders'),
    }));
    expect(flowPack.definitionCandidates[0]).toEqual(expect.objectContaining({
      symbol: expect.stringContaining('OrderResource.listOrders'),
      frameworkRole: 'endpoint:handler',
    }));
    expect(flowPack.evidenceSlices.some(slice => slice.file.endsWith('OrderResource.java') && slice.text.includes('service.listOrders()'))).toBe(true);
    expect(flowPack.callees.some(edge => edge.callee.includes('OrderService.listOrders'))).toBe(true);

    const rootedPromptPack = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_flow_pack',
      args: {
        target: 'Apache Hadoop at D:/Personal/Projects/hadoop GET /api/orders request flow',
        profile: 'full',
        tokenBudget: 6000,
      },
    }) as {
      definitionCandidates: Array<{ symbol: string; frameworkRole?: string }>;
      impactedEndpoints: Array<{ method: string; path: string; handlerSymbol: string }>;
      routing: { answerDirectly: boolean };
    };
    expect(rootedPromptPack.routing.answerDirectly).toBe(true);
    expect(rootedPromptPack.impactedEndpoints).toContainEqual(expect.objectContaining({
      method: 'GET',
      path: '/api/orders',
      handlerSymbol: expect.stringContaining('OrderResource.listOrders'),
    }));
    expect(rootedPromptPack.definitionCandidates[0]).toEqual(expect.objectContaining({
      symbol: expect.stringContaining('OrderResource.listOrders'),
      frameworkRole: 'endpoint:handler',
    }));

    const directCallees = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callees',
      args: {
        symbol: flowPack.impactedEndpoints[0].handlerSymbol,
        limit: 10,
        includeLowSignal: true,
      },
    }) as { callees: Array<{ callee: string }> };
    expect(directCallees.callees.some(edge => edge.callee.includes('OrderService.listOrders'))).toBe(true);
  });

  it('prioritizes exact TypeScript tool symbols in research packs', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-ts-tool-research-');
    writeFile(repo, 'src/v2/mcp/tools.ts', `export const V2ToolSchemas = {
  search_symbol: {},
  review_patch: {},
};

export const V2_TOOL_DEFINITIONS = Object.entries(V2ToolSchemas);
`);
    writeFile(repo, 'src/v2/query/service.ts', `export class V2QueryService {
  async query(toolName: string): Promise<unknown> {
    if (toolName === 'review_patch') return this.reviewPatch();
    return {};
  }

  private async reviewPatch(): Promise<unknown> {
    return { verdict: 'ok' };
  }
}
`);
    writeFile(repo, 'src/v2/benchmark/review-proof.ts', `export async function runMcpReviewProof(queryService: { query(input: unknown): Promise<unknown> }) {
  return queryService.query({ toolName: 'review_patch' });
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const symbolSearch = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'review_patch', limit: 5 },
    }) as { symbols: Array<{ fqName: string; file: string }> };
    expect(symbolSearch.symbols.some(symbol => symbol.fqName.includes('V2ToolSchemas.review_patch'))).toBe(true);

    const researchPack = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_research_pack',
      args: {
        target: 'review_patch MCP',
        taskType: 'architecture',
        tokenBudget: 5000,
      },
    }) as {
      definitionCandidates: Array<{ symbol: string; file: string }>;
      topFiles: string[];
      evidenceSlices: Array<{ file: string; text: string }>;
    };

    expect(researchPack.definitionCandidates.some(symbol => symbol.symbol.includes('V2ToolSchemas.review_patch'))).toBe(true);
    expect(researchPack.definitionCandidates.some(symbol => symbol.symbol.includes('V2QueryService.reviewPatch'))).toBe(true);
    expect(researchPack.topFiles[0]).toBe('src/v2/mcp/tools.ts');
    expect(researchPack.evidenceSlices.some(slice => slice.file === 'src/v2/mcp/tools.ts' && slice.text.includes('review_patch'))).toBe(true);
    expect(researchPack.evidenceSlices.some(slice => slice.file === 'src/v2/query/service.ts' && slice.text.includes('reviewPatch'))).toBe(true);
  });

  it('generates a deterministic repo atlas from indexed facts', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-repo-atlas-');
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
    private final OrderRepository repository = new OrderRepository();

    public String listOrders() {
        return repository.findAll();
    }
}
`);
    writeFile(repo, 'src/main/java/com/example/orders/OrderRepository.java', `package com.example.orders;

public class OrderRepository {
    public String findAll() {
        return "[]";
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

    const atlas = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'generate_repo_atlas',
      args: {
        profile: 'compact',
        maxModules: 8,
        maxEntrypoints: 10,
        maxHotspots: 10,
        warnStale: false,
      },
    }) as {
      reportType: string;
      systemMentalModel: string[];
      summary: { counts: { files: number; endpoints: number } };
      architecture: {
        modules: Array<{ label: string; files: number }>;
        entrypoints: Array<{ method: string; path: string; handlerSymbol: string; file: string }>;
        topFiles: Array<{ file: string; riskLevel: string; why: string[] }>;
      };
      featureMap: { flows: Array<{ handler: string; primaryFiles: string[]; likelyTests: Array<{ file: string }> }> };
      changePlaybook: { validation: { suggestedCommands: string[] } };
      budget: { estimatedResponseTokens: number; queryTimeMs: number };
    };

    expect(atlas.reportType).toBe('repo_atlas');
    expect(atlas.systemMentalModel.join(' ')).toContain('persistent CodeGraph facts');
    expect(atlas.summary.counts.files).toBeGreaterThanOrEqual(5);
    expect(atlas.summary.counts.endpoints).toBeGreaterThanOrEqual(1);
    expect(atlas.architecture.modules.length).toBeGreaterThan(0);
    expect(atlas.architecture.modules[0].files).toBeGreaterThan(0);
    expect(atlas.architecture.entrypoints).toContainEqual(expect.objectContaining({
      method: 'GET',
      path: '/orders',
      handlerSymbol: expect.stringContaining('OrderController.list'),
      file: 'src/main/java/com/example/orders/OrderController.java',
    }));
    expect(atlas.featureMap.flows.some(flow => flow.handler.includes('OrderController.list'))).toBe(true);
    expect(atlas.featureMap.flows.some(flow => flow.primaryFiles.includes('src/main/java/com/example/orders/OrderController.java'))).toBe(true);
    expect(atlas.featureMap.flows.some(flow => flow.likelyTests.some(test => test.file.endsWith('OrderServiceTest.java')))).toBe(true);
    expect(atlas.architecture.topFiles.some(file => file.file.endsWith('OrderController.java') && file.riskLevel !== 'low')).toBe(true);
    expect(atlas.changePlaybook.validation.suggestedCommands.length).toBeGreaterThan(0);
    expect(atlas.budget.estimatedResponseTokens).toBeGreaterThan(0);

    const markdown = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'generate_repo_atlas',
      args: {
        format: 'markdown',
        profile: 'micro',
        warnStale: false,
      },
    }) as { format: string; markdown: string; budget: { estimatedResponseTokens: number } };
    expect(markdown.format).toBe('markdown');
    expect(markdown.markdown).toContain('# CodeGraph Repo Atlas');
    expect(markdown.markdown).toContain('GET /orders');
    expect(markdown.budget.estimatedResponseTokens).toBeLessThan(atlas.budget.estimatedResponseTokens);
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

    const cappedImpact = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'simulate_patch_impact',
      args: {
        files: ['src/main/java/com/example/orders/OrderService.java'],
        symbols: ['OrderController.list'],
        diff,
        limit: 20,
        outputMode: 'full',
        maxResponseTokens: 500,
      },
    }) as {
      outputMode: string;
      changedFiles: string[];
      changedEndpoints: Array<{ path: string }>;
      summary: { changedFileCount: number };
      budget: {
        responseCap: {
          maxResponseTokens: number;
          capped: boolean;
          estimatedResponseTokens: number;
          estimatedFullResponseTokens: number;
          estimatedTokensSaved: number;
        };
      };
    };

    expect(cappedImpact.outputMode).toBe('compact-capped');
    expect(cappedImpact.changedFiles.some(file => file.endsWith('OrderService.java'))).toBe(true);
    expect(cappedImpact.changedEndpoints.some(endpoint => endpoint.path === '/orders')).toBe(true);
    expect(cappedImpact.summary.changedFileCount).toBe(2);
    expect(cappedImpact.budget.responseCap.maxResponseTokens).toBe(500);
    expect(cappedImpact.budget.responseCap.capped).toBe(true);
    expect(cappedImpact.budget.responseCap.estimatedFullResponseTokens)
      .toBeGreaterThan(cappedImpact.budget.responseCap.estimatedResponseTokens);
    expect(cappedImpact.budget.responseCap.estimatedTokensSaved).toBeGreaterThan(0);

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
      reviewFindings: Array<{ id: string; priority: string; severity?: string; category?: string; suggestedFix?: string }>;
      lineFocus: Array<{ file: string; changeKinds: string[]; lineMappingConfidence?: string }>;
      reviewTargets: Array<{
        file: string;
        changedSymbol?: { symbol?: string; name?: string };
        graphContext?: { callers?: unknown[]; tests?: unknown[]; counts?: { callers?: number } };
        recommendedChecks?: string[];
      }>;
      seededRiskCategories: Array<{ id: string; severity: string }>;
      mustCheckInvariants: string[];
      knownSensitiveDataPatterns: Array<{ id: string; pattern: string }>;
      precisionTargets: { requireFileLineForBlockers: boolean; maxUnsupportedClaims: number };
      followUpSliceHints: Array<{ file: string; lines: string; maxChars: number }>;
      firstFollowUpToolCall?: { tool: string; args: { slices?: Array<{ file?: string; lines?: string; maxChars?: number }> } };
      agentGuidance?: {
        findingContract?: { requiredFields?: string[] };
        reviewOrder?: unknown[];
        sourceInspection?: { firstTool?: string; sliceCount?: number };
      };
      requiredToolCalls: Array<{ tool: string }>;
      metrics: { findingCount: number; omittedHunks: number; reviewTargetCount: number };
      budget: { evidenceHandleCount: number; capExceeded: boolean; estimatedResponseTokens: number };
    };

    expect(review.outputMode).toBe('compact');
    expect(review.reviewStatus).toBe('needs-attention');
    expect(review.reviewFindings.some(finding => finding.id === 'review-endpoint-contract')).toBe(true);
    expect(review.reviewFindings.some(finding => finding.id.includes('review-debug-output'))).toBe(true);
    expect(review.reviewFindings.some(finding => finding.severity === 'medium' && finding.category === 'observability')).toBe(true);
    expect(review.reviewFindings.some(finding => finding.suggestedFix)).toBe(true);
    expect(review.lineFocus.some(hunk => hunk.file.endsWith('OrderController.java') && hunk.changeKinds.includes('debug-output'))).toBe(true);
    expect(review.lineFocus.some(hunk => hunk.file.endsWith('OrderController.java') && hunk.lineMappingConfidence === 'low')).toBe(true);
    expect(review.reviewTargets.some(target => target.file.endsWith('OrderController.java')
      && target.changedSymbol?.symbol?.includes('OrderController.list')
      && target.recommendedChecks?.some(check => check.includes('debug output')))).toBe(true);
    expect(review.seededRiskCategories.some(category => category.id === 'api-contract')).toBe(true);
    expect(review.mustCheckInvariants.some(invariant => invariant.includes('Endpoint/API changes'))).toBe(true);
    expect(review.knownSensitiveDataPatterns.some(pattern => pattern.id === 'identifier-logging')).toBe(true);
    expect(review.precisionTargets).toMatchObject({ requireFileLineForBlockers: true, maxUnsupportedClaims: 0 });
    expect(review.agentGuidance?.findingContract?.requiredFields).toContain('suggestedFix');
    expect(review.requiredToolCalls.some(call => call.tool === 'get_file_summary')).toBe(true);
    expect(review.followUpSliceHints).toHaveLength(0);
    expect(review.firstFollowUpToolCall).toBeUndefined();
    expect(review.budget.evidenceHandleCount).toBeGreaterThan(0);
    expect(review.budget.capExceeded).toBe(false);
    expect(review.metrics.findingCount).toBeGreaterThan(0);
    expect(review.metrics.omittedHunks).toBe(0);
    expect(review.metrics.reviewTargetCount).toBeGreaterThan(0);

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
      followUpSliceHints: Array<{ file: string; lines: string }>;
      firstFollowUpToolCall?: { tool: string; args: { slices?: Array<{ file?: string; lines?: string }> } };
      agentGuidance?: { sourceInspection?: { firstTool?: string; sliceCount?: number } };
      requiredToolCalls: Array<{ tool: string }>;
    };
    expect(matchingReview.lineFocus.some(hunk => hunk.lineMappingConfidence === 'high')).toBe(true);
    expect(matchingReview.requiredToolCalls.some(call => call.tool === 'get_file_slice')).toBe(true);
    expect(matchingReview.followUpSliceHints.some(hint => hint.file.endsWith('OrderController.java'))).toBe(true);
    expect(matchingReview.firstFollowUpToolCall?.tool).toBe('get_file_slice');
    expect(matchingReview.firstFollowUpToolCall?.args.slices?.some(slice => slice.file?.endsWith('OrderController.java'))).toBe(true);
    expect(matchingReview.agentGuidance?.sourceInspection?.firstTool).toBe('get_file_slice');
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

  it('exports a static graph with inferred services, endpoint links, and caps', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-static-graph-');
    writeFile(repo, 'order-service/pom.xml', `<project>
  <artifactId>order-service</artifactId>
</project>
`);
    writeFile(repo, 'payment-service/pom.xml', `<project>
  <artifactId>payment-service</artifactId>
</project>
`);
    writeFile(repo, 'docker-compose.yml', `services:
  order-service:
    image: example/order-service:latest
  payment-service:
    image: example/payment-service:latest
`);
    writeFile(repo, 'order-service/src/main/java/com/example/order/OrderController.java', `package com.example.order;

import com.example.payment.PaymentClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/orders")
public class OrderController {
    private final PaymentClient paymentClient;

    public OrderController(PaymentClient paymentClient) {
        this.paymentClient = paymentClient;
    }

    @GetMapping("/{id}")
    public String getOrder(String id) {
        paymentClient.authorize(id);
        return id;
    }
}
`);
    writeFile(repo, 'order-service/src/test/java/com/example/order/OrderControllerTest.java', `package com.example.order;

public class OrderControllerTest {
}
`);
    writeFile(repo, 'payment-service/src/main/java/com/example/payment/PaymentClient.java', `package com.example.payment;

public class PaymentClient {
    public boolean authorize(String orderId) {
        return true;
    }
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const previousOverlayFlag = process.env.CODEGRAPH_ENABLE_GRAPH_OVERLAY;
    process.env.CODEGRAPH_ENABLE_GRAPH_OVERLAY = '1';
    let result: Awaited<ReturnType<V2Indexer['indexWorkspace']>>;
    try {
      result = await indexer.indexWorkspace({ root: repo });
    } finally {
      if (previousOverlayFlag === undefined) {
        delete process.env.CODEGRAPH_ENABLE_GRAPH_OVERLAY;
      } else {
        process.env.CODEGRAPH_ENABLE_GRAPH_OVERLAY = previousOverlayFlag;
      }
    }
    const overlayStats = await db.prepare(`
      SELECT graph_nodes, graph_edges
      FROM snapshot_stats
      WHERE snapshot_id = ?
    `).get(result.snapshotId) as { graph_nodes: number; graph_edges: number } | undefined;
    expect(overlayStats?.graph_nodes).toBeGreaterThan(0);
    expect(overlayStats?.graph_edges).toBeGreaterThan(0);

    const overlayModules = await db.prepare(`
      SELECT label
      FROM graph_nodes
      WHERE snapshot_id = ? AND node_type = 'module'
      ORDER BY label
    `).all(result.snapshotId) as Array<{ label: string }>;
    expect(overlayModules.map(module => module.label)).toContain('order-service');
    expect(overlayModules.map(module => module.label)).toContain('payment-service');

    const overlayCrossEdges = await db.prepare(`
      SELECT edge_type, edge_count, evidence_json
      FROM graph_edges
      WHERE snapshot_id = ? AND edge_type IN ('module_dependency', 'module_call')
    `).all(result.snapshotId) as Array<{ edge_type: string; edge_count: number; evidence_json: string }>;
    expect(overlayCrossEdges.some(edge => edge.edge_type === 'module_dependency' && edge.edge_count > 0)).toBe(true);
    expect(overlayCrossEdges.some(edge => edge.evidence_json.includes('OrderController.java') && edge.evidence_json.includes('PaymentClient.java'))).toBe(true);

    const queries = new V2QueryService(db);
    const flowPack = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_flow_pack',
      args: { target: '/orders/{id}', profile: 'standard' },
    }) as { architectureContext?: { available?: boolean; modules?: Array<{ label: string }>; moduleEdges?: unknown[] } };
    expect(flowPack.architectureContext?.available).toBe(true);
    expect(flowPack.architectureContext?.modules?.some(module => module.label === 'order-service')).toBe(true);

    const graph = await buildGraphExport(db, {
      workspaceId: result.workspaceId,
      snapshotId: result.snapshotId,
      root: repo,
      maxNodes: 200,
      maxEdges: 400,
    });
    const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
    const groupLabels = graph.groups.map(group => group.label);

    expect(groupLabels).toContain('order-service');
    expect(groupLabels).toContain('payment-service');
    expect(graph.nodes).toContainEqual(expect.objectContaining({
      kind: 'endpoint',
      label: 'GET /orders/{id}',
    }));
    expect(graph.edges.some(edge => edge.kind === 'endpoint_handler')).toBe(true);
    expect(graph.edges.some(edge => edge.kind === 'call')).toBe(true);
    expect(graph.edges.some(edge => {
      const from = nodeById.get(edge.from);
      const to = nodeById.get(edge.to);
      return edge.kind === 'dependency'
        && from?.file?.endsWith('OrderController.java')
        && to?.file?.endsWith('PaymentClient.java');
    })).toBe(true);
    expect(graph.edges.some(edge => edge.kind === 'cross_service')).toBe(true);

    const defaultFiles = graph.nodes.filter(node => node.kind === 'file').map(node => node.file);
    expect(defaultFiles.some(file => file?.endsWith('OrderControllerTest.java'))).toBe(false);
    const withTests = await buildGraphExport(db, {
      workspaceId: result.workspaceId,
      snapshotId: result.snapshotId,
      root: repo,
      maxNodes: 200,
      maxEdges: 400,
      includeTests: true,
    });
    expect(withTests.nodes.some(node => node.file?.endsWith('OrderControllerTest.java'))).toBe(true);

    const capped = await buildGraphExport(db, {
      workspaceId: result.workspaceId,
      snapshotId: result.snapshotId,
      root: repo,
      maxNodes: 3,
      maxEdges: 1,
    });
    expect(capped.metadata.truncated).toBe(true);
    expect(capped.stats.hiddenNodes).toBeGreaterThan(0);

    const html = renderGraphHtml(graph);
    expect(html).toContain('CodeGraph Static View');
    expect(html).toContain('Under Nodes / Related Calls');
    expect(html).toContain('<svg id="graph"');
    expect(html).toContain('id="graph-data"');
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
  });

  it('keeps field usage facts full but skips expensive field overlay edges unless opted in', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-field-overlay-');
    writeFile(repo, 'field-owner/pom.xml', `<project>
  <artifactId>field-owner</artifactId>
</project>
`);
    writeFile(repo, 'field-reader/pom.xml', `<project>
  <artifactId>field-reader</artifactId>
</project>
`);
    writeFile(repo, 'field-owner/src/main/java/com/example/owner/Owner.java', `package com.example.owner;

public class Owner {
    public int fieldA;
}
`);
    writeFile(repo, 'field-reader/src/main/java/com/example/reader/Reader.java', `package com.example.reader;

import com.example.owner.Owner;

public class Reader {
    public int read(Owner owner) {
        return owner.fieldA;
    }
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const previousOverlayFlag = process.env.CODEGRAPH_ENABLE_GRAPH_OVERLAY;
    const previousFieldOverlayFlag = process.env.CODEGRAPH_GRAPH_OVERLAY_FIELD_USAGE_EDGES;
    process.env.CODEGRAPH_ENABLE_GRAPH_OVERLAY = '1';
    delete process.env.CODEGRAPH_GRAPH_OVERLAY_FIELD_USAGE_EDGES;
    try {
      const defaultResult = await indexer.indexWorkspace({ root: repo, workspaceKey: 'field-overlay-default' });
      const ownerFile = 'field-owner/src/main/java/com/example/owner/Owner.java';
      const readerFile = 'field-reader/src/main/java/com/example/reader/Reader.java';
      await db.prepare(`
        INSERT INTO symbols (
          snapshot_id, fq_name, simple_name, kind, file, line, column, end_line,
          signature, visibility, parent, package_name, return_type,
          parameter_types_json, annotations_json, framework_role, framework_meta_json, file_role
        )
        VALUES (?, 'Owner.fieldA', 'fieldA', 'field', ?, 4, 16, 4, 'public int fieldA', 'public',
          'Owner', 'com.example.owner', '', '[]', '[]', NULL, '{}', 'source')
        ON CONFLICT DO NOTHING
      `).run(defaultResult.snapshotId, ownerFile);
      await db.prepare(`
        INSERT INTO field_usages (
          snapshot_id, field_name, field_fq_name, owner_class, file, line, column,
          enclosing_class, enclosing_symbol, access_kind, receiver_text, context,
          confidence, resolution_kind, file_role
        )
        VALUES (?, 'fieldA', 'Owner.fieldA', 'Owner', ?, 7, 22, 'Reader',
          'Reader.read', 'read', 'owner', 'return owner.fieldA;', 0.8, 'receiver-type-field', 'source')
      `).run(defaultResult.snapshotId, readerFile);

      const fieldUsageRow = await db.prepare(`
        SELECT COUNT(*) AS count FROM field_usages
        WHERE snapshot_id = ? AND field_name = 'fieldA'
      `).get(defaultResult.snapshotId) as { count: number | string };
      expect(Number(fieldUsageRow.count)).toBeGreaterThan(0);

      await rebuildGraphOverlay(db, defaultResult.snapshotId);
      const defaultOverlayRow = await db.prepare(`
        SELECT COUNT(*) AS count FROM graph_edges
        WHERE snapshot_id = ? AND edge_type = 'module_field_usage'
      `).get(defaultResult.snapshotId) as { count: number | string };
      expect(Number(defaultOverlayRow.count)).toBe(0);

      await rebuildGraphOverlay(db, defaultResult.snapshotId, { includeFieldUsageEdges: true });
      const optInOverlayRow = await db.prepare(`
        SELECT COUNT(*) AS count FROM graph_edges
        WHERE snapshot_id = ? AND edge_type = 'module_field_usage'
      `).get(defaultResult.snapshotId) as { count: number | string };
      expect(Number(optInOverlayRow.count)).toBeGreaterThan(0);
    } finally {
      if (previousOverlayFlag === undefined) {
        delete process.env.CODEGRAPH_ENABLE_GRAPH_OVERLAY;
      } else {
        process.env.CODEGRAPH_ENABLE_GRAPH_OVERLAY = previousOverlayFlag;
      }
      if (previousFieldOverlayFlag === undefined) {
        delete process.env.CODEGRAPH_GRAPH_OVERLAY_FIELD_USAGE_EDGES;
      } else {
        process.env.CODEGRAPH_GRAPH_OVERLAY_FIELD_USAGE_EDGES = previousFieldOverlayFlag;
      }
    }
  });

  it('exports graph HTML from the CLI and reports missing snapshots for --no-index', () => {
    const repo = tempDir('codegraph-cli-graph-');
    const outDir = tempDir('codegraph-cli-graph-out-');
    const out = path.join(outDir, 'graph.html');
    writeFile(repo, 'src/main/java/com/example/Demo.java', `package com.example;

public class Demo {
}
`);

    const output = execFileSync(process.execPath, tsxArgs([
      'src/cli.ts',
      'graph',
      '--root',
      repo,
      '--out',
      out,
      '--workspace-key',
      'cli-graph-test',
      '--quiet',
    ]), { cwd: path.resolve('.'), encoding: 'utf-8' });
    const parsed = JSON.parse(output) as { out: string; nodes: number; edges: number };

    expect(parsed.out).toBe(path.resolve(out));
    expect(parsed.nodes).toBeGreaterThan(0);
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out, 'utf-8')).toContain('CodeGraph Static View');

    const freshRepo = tempDir('codegraph-cli-graph-missing-');
    writeFile(freshRepo, 'src/main/java/com/example/Missing.java', `package com.example;

public class Missing {
}
`);
    let stderr = '';
    try {
      execFileSync(process.execPath, tsxArgs([
        'src/cli.ts',
        'graph',
        '--root',
        freshRepo,
        '--out',
        path.join(outDir, 'missing.html'),
        '--no-index',
        '--quiet',
      ]), { cwd: path.resolve('.'), stdio: 'pipe' });
    } catch (error) {
      stderr = String((error as { stderr?: Buffer }).stderr ?? '');
    }
    expect(stderr).toContain('No current CodeGraph snapshot found');
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

  it('parses Codex CLI JSON events into tool, token, output, and quality metrics', () => {
    const jsonl = [
      JSON.stringify({
        type: 'mcp_tool_call.started',
        data: { id: 'call-1', name: 'get_flow_pack' },
      }),
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'call-3',
          type: 'mcp_tool_call',
          server: 'codegraph_bench',
          tool: 'find_references',
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'call-3',
          type: 'mcp_tool_call',
          server: 'codegraph_bench',
          tool: 'find_references',
        },
      }),
      JSON.stringify({
        type: 'tool_call.started',
        item: { id: 'call-2', type: 'tool_call', name: 'shell_command' },
      }),
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'call-4',
          type: 'command_execution',
          command: 'rg "RMWebServices" D:/Personal/Projects/hadoop',
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'call-4',
          type: 'command_execution',
          command: 'rg "RMWebServices" D:/Personal/Projects/hadoop',
        },
      }),
      JSON.stringify({
        type: 'assistant.message',
        data: {
          role: 'assistant',
          content: '{"task":"api-flow","keyFiles":["RMWebServices.java"],"methods":["getApps"],"flow":["applicationTags"]}',
        },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 1200,
          cached_input_tokens: 400,
          output_tokens: 180,
          reasoning_tokens: 40,
        },
      }),
    ].join('\n');

    const parsed = parseCodexJsonEvents(jsonl, 'Trace /ws/v1/cluster/apps');
    expect(parsed.eventCount).toBe(8);
    expect(parsed.mcpCalls).toBe(2);
    expect(parsed.shellCalls).toBe(2);
    expect(parsed.toolCalls).toBe(4);
    expect(parsed.inputTokens).toBe(1200);
    expect(parsed.cachedInputTokens).toBe(400);
    expect(parsed.outputTokens).toBe(180);
    expect(parsed.reasoningTokens).toBe(40);
    expect(parsed.tokenSource).toBe('actual');
    expect(parsed.finalOutput).toContain('RMWebServices.java');

    const quality = scoreCodexOutput({
      id: 'api-flow',
      prompt: 'Trace app API',
      expectedFiles: ['RMWebServices.java'],
      expectedMethods: ['getApps'],
      expectedTerms: ['applicationTags'],
      requiredAnswerFields: ['keyFiles'],
    }, parsed.finalOutput);
    expect(quality.score).toBe(1);
    expect(quality.misses).toHaveLength(0);
  });

  it('builds compact MCP tool descriptions without changing tool schemas', () => {
    const normal = buildV2ToolDefinitions();
    const compact = buildV2ToolDefinitions({ compactDescriptions: true });

    expect(compact.map(tool => tool.name)).toEqual(normal.map(tool => tool.name));
    expect(compact.map(tool => tool.inputSchema)).toEqual(normal.map(tool => tool.inputSchema));
    expect(compact.find(tool => tool.name === 'get_flow_pack')?.description).toContain('get_change_pack');
    expect(compact.find(tool => tool.name === 'get_file_slice')?.description).toContain('slices[]');
    expect(V2_TOOL_DEFINITIONS.find(tool => tool.name === 'get_flow_pack')?.description).toBe(
      compact.find(tool => tool.name === 'get_flow_pack')?.description,
    );

    const normalChars = normal.reduce((sum, tool) => sum + tool.description.length, 0);
    const compactChars = compact.reduce((sum, tool) => sum + tool.description.length, 0);
    expect(compactChars).toBeLessThan(normalChars * 0.75);
  });

  it('uses a single full MCP tool mode and treats legacy profiles as aliases', () => {
    expect(mcpToolNamesForProfile('client')).toEqual(new Set(V2_TOOL_PROFILES.client));
    expect(mcpToolNamesForProfile('minimal')).toEqual(new Set(V2_TOOL_PROFILES.minimal));
    expect(mcpToolNamesForProfile('research')).toEqual(new Set(V2_TOOL_PROFILES.research));
    expect(mcpToolNamesForProfile('change')).toEqual(new Set(V2_TOOL_PROFILES.change));
    expect(mcpToolNamesForProfile('review')).toEqual(new Set(V2_TOOL_PROFILES.review));
    expect(mcpToolNamesForProfile('full')).toEqual(new Set(V2_TOOL_PROFILES.full));
    expect(V2_TOOL_PROFILES.minimal).toEqual(V2_TOOL_PROFILES.client);
    expect(V2_TOOL_PROFILES.research).toEqual(V2_TOOL_PROFILES.client);
    expect(V2_TOOL_PROFILES.change).toEqual(V2_TOOL_PROFILES.client);
    expect(V2_TOOL_PROFILES.review).toEqual(V2_TOOL_PROFILES.client);
    expect(() => mcpToolNamesForProfile('unknown')).toThrow(/Unknown MCP tool profile/);
  });

  it('resolves Java parameter and local-variable receiver calls through sharded full indexing', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-receiver-types-');
    writeFile(repo, 'src/main/java/com/example/LocalCallService.java', `package com.example;

public class LocalCallService {
    public void execute(PaymentGateway gateway, PaymentInfo paymentInfo) {
        gateway.processPayment(paymentInfo.getAmount());
        PaymentGateway localGateway = gateway;
        localGateway.processRefund("tx-1");
        assertThat(gateway);
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
    writeFile(repo, 'src/main/java/com/example/PaymentInfoCopy.java', `package com.example;

public class PaymentInfo {
    public double getAmount() {
        return 10.0;
    }
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const progressEvents: IndexProgressEvent[] = [];
    const previousSharded = process.env.CODEGRAPH_ENABLE_SHARDED_FULL_INDEX;
    process.env.CODEGRAPH_ENABLE_SHARDED_FULL_INDEX = '1';
    let result: Awaited<ReturnType<V2Indexer['indexWorkspace']>>;
    try {
      result = await indexer.indexWorkspace({ root: repo, progress: event => progressEvents.push(event) });
    } finally {
      if (previousSharded === undefined) {
        delete process.env.CODEGRAPH_ENABLE_SHARDED_FULL_INDEX;
      } else {
        process.env.CODEGRAPH_ENABLE_SHARDED_FULL_INDEX = previousSharded;
      }
    }
    const queries = new V2QueryService(db);

    expect(progressEvents.some(event => event.details?.sharded === true)).toBe(true);
    expect(progressEvents.some(event => event.message === 'call fact shard resolved')).toBe(true);
    expect(progressEvents.at(-1)?.details?.copyFallbacks).toBe(0);

    const parseCacheCount = await db.scalar('SELECT COUNT(*) FROM parse_cache');
    expect(parseCacheCount).toBeGreaterThan(0);
    expect(parseCacheCount).toBeLessThan(result.filesParsed);
    const stats = await db.prepare(`
      SELECT files, symbols, call_edges, call_edges_low_signal
      FROM snapshot_stats
      WHERE snapshot_id = ?
    `).get(result.snapshotId) as { files: number | string; symbols: number | string; call_edges: number | string; call_edges_low_signal: number | string } | undefined;
    expect(Number(stats?.files ?? 0)).toBe(result.filesTotal);
    expect(Number(stats?.symbols ?? 0)).toBeGreaterThan(0);
    expect(Number(stats?.call_edges ?? 0)).toBeGreaterThan(0);

    const paymentCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'PaymentGateway.processPayment' },
    }) as { callers: Array<{ callee: string; resolution_kind: string }> };

    expect(paymentCallers.callers).toContainEqual(expect.objectContaining({
      callee: 'PaymentGateway.processPayment',
      resolution_kind: 'receiver-type',
    }));

    const refundCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'PaymentGateway.processRefund' },
    }) as { callers: Array<{ callee: string; resolution_kind: string }> };

    expect(refundCallers.callers).toContainEqual(expect.objectContaining({
      callee: 'PaymentGateway.processRefund',
      resolution_kind: 'receiver-type',
    }));

    const amountCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'PaymentInfo.getAmount' },
    }) as { callers: Array<{ callee: string; resolution_kind: string }> };

    expect(amountCallers.callers).toContainEqual(expect.objectContaining({
      callee: 'PaymentInfo.getAmount',
      resolution_kind: 'receiver-type',
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

    const lowSignalRows = await db.prepare(`
      SELECT callee, signal_tier
      FROM call_edges
      WHERE snapshot_id = ? AND callee = 'assertThat'
    `).all(result.snapshotId) as Array<{ callee: string; signal_tier: string }>;
    expect(lowSignalRows).toContainEqual(expect.objectContaining({
      callee: 'assertThat',
      signal_tier: 'low_signal',
    }));

    const warm = await indexer.indexWorkspace({ root: repo });
    expect(warm.skippedUnchanged).toBe(true);
    expect(warm.parseCacheHits).toBe(warm.filesTotal);
  });

  it('indexes Java method references and lambda callback call edges', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-callback-refs-');
    writeFile(repo, 'src/main/java/com/example/CallbackRegistration.java', `package com.example;

import java.util.function.Consumer;

public class CallbackRegistration extends BaseCallback {
    private final PaymentGateway gateway;

    public CallbackRegistration(PaymentGateway gateway) {
        this.gateway = gateway;
    }

    public void register(EventBus bus, WorkerService worker) {
        bus.onPayment(this::handlePayment);
        bus.onPayment(super::baseHook);
        bus.onPayment(gateway::processPayment);
        bus.onPayment(PaymentGateway::audit);
        bus.runLater(() -> worker.runJob());
    }

    public void handlePayment(PaymentInfo info) {
    }
}

class BaseCallback {
    public void baseHook(PaymentInfo info) {
    }
}

interface EventBus {
    void onPayment(Consumer<PaymentInfo> callback);
    void runLater(Runnable callback);
}

interface PaymentGateway {
    void processPayment(PaymentInfo info);
    static void audit(PaymentInfo info) {
    }
}

class WorkerService {
    public void runJob() {
    }
}

class PaymentInfo {
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const handleCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'CallbackRegistration.handlePayment', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(handleCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'CallbackRegistration.register',
      callee: 'CallbackRegistration.handlePayment',
      resolution_kind: 'method-reference',
    }));

    const superCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'BaseCallback.baseHook', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(superCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'CallbackRegistration.register',
      callee: 'BaseCallback.baseHook',
      resolution_kind: 'method-reference',
    }));

    const fieldReceiverCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'PaymentGateway.processPayment', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(fieldReceiverCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'CallbackRegistration.register',
      callee: 'PaymentGateway.processPayment',
      resolution_kind: 'receiver-field',
    }));

    const staticReferenceCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'find_references',
      args: { symbol: 'PaymentGateway.audit', kind: 'call', includeLowSignal: true },
    }) as { references: Array<{ caller: string; callee: string; kind: string }> };
    expect(staticReferenceCallers.references).toContainEqual(expect.objectContaining({
      caller: 'CallbackRegistration.register',
      callee: 'PaymentGateway.audit',
      kind: 'call',
    }));

    const lambdaCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'WorkerService.runJob', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string }> };
    expect(lambdaCallers.callers).toContainEqual(expect.objectContaining({
      caller: expect.stringMatching(/^CallbackRegistration[.]register[.]lambda\d+_\d+$/),
      callee: 'WorkerService.runJob',
    }));

    const callbackEdges = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callees',
      args: { symbol: 'CallbackRegistration.register', includeLowSignal: true },
    }) as { callees: Array<{ callee: string; resolution_kind: string }> };
    expect(callbackEdges.callees).toContainEqual(expect.objectContaining({
      callee: expect.stringMatching(/^CallbackRegistration[.]register[.]lambda\d+_\d+$/),
      resolution_kind: 'lambda-callback',
    }));
  });

  it('resolves inherited and qualified outer Java method references to the owning method', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-java-outer-this-method-refs-');
    writeFile(repo, 'src/main/java/com/example/OuterCallback.java', `package com.example;

import java.util.function.Consumer;
import java.util.stream.Stream;

public class OuterCallback extends BaseCallback {
    void register(EventBus bus) {
        bus.onPayment(this::inheritedHook);
    }

    String mapInfo(PaymentInfo info) {
        return "";
    }

    class InnerRegistrar {
        void wire(Stream<PaymentInfo> payments) {
            payments.map(OuterCallback.this::mapInfo).toList();
        }
    }
}

class BaseCallback {
    void inheritedHook(PaymentInfo info) {
    }
}

interface EventBus {
    void onPayment(Consumer<PaymentInfo> callback);
}

class PaymentInfo {
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const inheritedCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'BaseCallback.inheritedHook', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(inheritedCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'OuterCallback.register',
      callee: 'BaseCallback.inheritedHook',
      resolution_kind: 'method-reference',
    }));

    const outerThisCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'OuterCallback.mapInfo', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(outerThisCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'InnerRegistrar.wire',
      callee: 'OuterCallback.mapInfo',
      resolution_kind: 'method-reference',
    }));
  });

  it('resolves inherited Java field receiver calls through superclass fields', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-inherited-field-receiver-');
    writeFile(repo, 'src/test/java/com/example/ControllerTestBase.java', `package com.example;

public abstract class ControllerTestBase {
    protected CurrentUser currentUser = new CurrentUser();
}
`);
    writeFile(repo, 'src/test/java/com/example/BazaarControllerTest.java', `package com.example;

public class BazaarControllerTest extends ControllerTestBase {
    public void setup() {
        currentUser.setUser("demo");
        currentUser.getUser();
    }

    class NestedCase {
        void nested() {
            currentUser.getUser();
        }
    }
}
`);
    writeFile(repo, 'src/test/java/com/example/CurrentUser.java', `package com.example;

public class CurrentUser {
    public void setUser(String value) {
    }

    public String getUser() {
        return "";
    }
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const setUserCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'CurrentUser.setUser', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(setUserCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'BazaarControllerTest.setup',
      callee: 'CurrentUser.setUser',
      resolution_kind: 'receiver-field',
    }));

    const getUserCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'CurrentUser.getUser', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(getUserCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'BazaarControllerTest.setup',
      callee: 'CurrentUser.getUser',
      resolution_kind: 'receiver-field',
    }));
    expect(getUserCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'NestedCase.nested',
      callee: 'CurrentUser.getUser',
      resolution_kind: 'receiver-field',
    }));
  });

  it('resolves unqualified Java method calls through current, outer, and superclass methods', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-enclosing-method-receiver-');
    writeFile(repo, 'src/test/java/com/example/BaseHelper.java', `package com.example;

public abstract class BaseHelper {
    protected void baseOnly() {
    }
}
`);
    writeFile(repo, 'src/test/java/com/example/HelperTest.java', `package com.example;

public class HelperTest extends BaseHelper {
    void helper() {
    }

    void wrapper() {
        helper();
        this.helper();
        baseOnly();
        super.baseOnly();
    }

    class NestedCase {
        void nested() {
            helper();
            baseOnly();
        }
    }
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const helperCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'HelperTest.helper', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(helperCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'HelperTest.wrapper',
      callee: 'HelperTest.helper',
      resolution_kind: 'enclosing-method',
    }));
    expect(helperCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'NestedCase.nested',
      callee: 'HelperTest.helper',
      resolution_kind: 'enclosing-method',
    }));

    const baseCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'BaseHelper.baseOnly', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(baseCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'HelperTest.wrapper',
      callee: 'BaseHelper.baseOnly',
      resolution_kind: 'enclosing-method',
    }));
    expect(baseCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'HelperTest.wrapper',
      callee: 'BaseHelper.baseOnly',
      resolution_kind: 'super-method',
    }));
    expect(baseCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'NestedCase.nested',
      callee: 'BaseHelper.baseOnly',
      resolution_kind: 'enclosing-method',
    }));
  });

  it('resolves Java named static imports to owner methods', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-java-static-imports-');
    writeFile(repo, 'src/main/java/com/example/Utility.java', `package com.example;

public class Utility {
    public static String parseXmlSecure() {
        return "";
    }

    public static byte[] readEntryBytes() {
        return new byte[0];
    }
}
`);
    writeFile(repo, 'src/main/java/com/example/Consumer.java', `package com.example;

import static com.example.Utility.parseXmlSecure;
import static com.example.Utility.readEntryBytes;

public class Consumer {
    void run() {
        parseXmlSecure();
        readEntryBytes();
    }
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const parseXmlCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'Utility.parseXmlSecure', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(parseXmlCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'Consumer.run',
      callee: 'Utility.parseXmlSecure',
      resolution_kind: 'static-import',
    }));

    const readEntryCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'Utility.readEntryBytes', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(readEntryCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'Consumer.run',
      callee: 'Utility.readEntryBytes',
      resolution_kind: 'static-import',
    }));
  });

  it('resolves Java enhanced-for and catch receiver calls through declared types', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-java-loop-catch-types-');
    writeFile(repo, 'src/main/java/com/example/LoopReceiver.java', `package com.example;

import java.io.IOException;
import java.util.Map;

public class LoopReceiver {
    void render(Map<String, String> values) {
        for (Map.Entry<String, String> entry : values.entrySet()) {
            entry.getKey();
            entry.getValue();
        }
    }

    void fail() {
        try {
            throw new IOException("x");
        } catch (IOException ex) {
            ex.getMessage();
        }
    }
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const keyCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'Entry.getKey', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(keyCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'LoopReceiver.render',
      callee: 'Entry.getKey',
      resolution_kind: 'receiver-type',
    }));

    const valueCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'Entry.getValue', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(valueCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'LoopReceiver.render',
      callee: 'Entry.getValue',
      resolution_kind: 'receiver-type',
    }));

    const messageCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'IOException.getMessage', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(messageCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'LoopReceiver.fail',
      callee: 'IOException.getMessage',
      resolution_kind: 'receiver-type',
    }));
  });

  it('resolves chained Java field receiver calls through nested field types', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-java-field-chain-');
    writeFile(repo, 'src/test/java/com/example/Persister.java', `package com.example;

public class Persister {
    public void flush() {
    }

    public void save() {
    }
}
`);
    writeFile(repo, 'src/test/java/com/example/MakeMe.java', `package com.example;

public class MakeMe {
    protected Persister entityPersister = new Persister();
}
`);
    writeFile(repo, 'src/test/java/com/example/BaseBuilder.java', `package com.example;

public abstract class BaseBuilder {
    protected MakeMe makeMe = new MakeMe();
}
`);
    writeFile(repo, 'src/test/java/com/example/BuilderTest.java', `package com.example;

public class BuilderTest extends BaseBuilder {
    void run() {
        makeMe.entityPersister.flush();
        this.makeMe.entityPersister.save();
    }
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const flushCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'Persister.flush', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(flushCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'BuilderTest.run',
      callee: 'Persister.flush',
      resolution_kind: 'receiver-field-chain',
    }));

    const saveCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'Persister.save', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(saveCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'BuilderTest.run',
      callee: 'Persister.save',
      resolution_kind: 'receiver-field-chain',
    }));
  });

  it('resolves Java typed receiver field chains through local and parameter types', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-java-typed-receiver-chain-');
    writeFile(repo, 'src/test/java/com/example/CatalogItems.java', `package com.example;

public class CatalogItems {
    public void stream() {
    }
}
`);
    writeFile(repo, 'src/test/java/com/example/CatalogView.java', `package com.example;

public class CatalogView {
    CatalogItems catalogItems = new CatalogItems();
}
`);
    writeFile(repo, 'src/test/java/com/example/Notebook.java', `package com.example;

public class Notebook {
    public int getId() {
        return 0;
    }
}
`);
    writeFile(repo, 'src/test/java/com/example/NotebookBox.java', `package com.example;

public class NotebookBox {
    Notebook note = new Notebook();
}
`);
    writeFile(repo, 'src/test/java/com/example/ViewContainer.java', `package com.example;

public class ViewContainer {
    NotebookBox wrap = new NotebookBox();
}
`);
    writeFile(repo, 'src/test/java/com/example/ViewRenderer.java', `package com.example;

public class ViewRenderer {
    void render(CatalogView view, ViewContainer container) {
        view.catalogItems.stream();
        container.wrap.note.getId();
    }
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const streamCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'CatalogItems.stream', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(streamCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'ViewRenderer.render',
      callee: 'CatalogItems.stream',
      resolution_kind: 'receiver-type-field',
    }));

    const getIdCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'Notebook.getId', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(getIdCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'ViewRenderer.render',
      callee: 'Notebook.getId',
      resolution_kind: 'receiver-type-chain',
    }));
  });

  it('resolves Java pattern variables and class-cast lambda parameters through typed receiver chains', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-java-pattern-chain-');
    writeFile(repo, 'src/test/java/com/example/Notebook.java', `package com.example;

public class Notebook {
    public Integer getId() {
        return 0;
    }
}
`);
    writeFile(repo, 'src/test/java/com/example/CatalogItem.java', `package com.example;

public interface CatalogItem {
}
`);
    writeFile(repo, 'src/test/java/com/example/NotebookCatalogNotebookItem.java', `package com.example;

public class NotebookCatalogNotebookItem implements CatalogItem {
    Notebook notebook = new Notebook();
}
`);
    writeFile(repo, 'src/test/java/com/example/NotebookCatalogSubscribedNotebookItem.java', `package com.example;

public class NotebookCatalogSubscribedNotebookItem implements CatalogItem {
    Notebook notebook = new Notebook();
}
`);
    writeFile(repo, 'src/test/java/com/example/NotebookCatalogGroupItem.java', `package com.example;

public class NotebookCatalogGroupItem implements CatalogItem {
}
`);
    writeFile(repo, 'src/test/java/com/example/PatternScope.java', `package com.example;

import java.util.List;

public class PatternScope {
    Integer fromSwitch(CatalogItem item) {
        return switch (item) {
            case NotebookCatalogNotebookItem n -> n.notebook.getId();
            case NotebookCatalogSubscribedNotebookItem s -> s.notebook.getId();
            case NotebookCatalogGroupItem g -> null;
        };
    }

    boolean fromInstanceof(List<CatalogItem> items, Integer needle) {
        return items.stream()
            .anyMatch(item -> item instanceof NotebookCatalogSubscribedNotebookItem s
                && s.notebook.getId().equals(needle));
    }

    List<Integer> fromCast(List<CatalogItem> items) {
        return items.stream()
            .filter(NotebookCatalogNotebookItem.class::isInstance)
            .map(NotebookCatalogNotebookItem.class::cast)
            .map(n -> n.notebook.getId())
            .toList();
    }
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const getIdCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'Notebook.getId', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };

    expect(getIdCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'PatternScope.fromSwitch',
      callee: 'Notebook.getId',
      resolution_kind: 'receiver-type-field',
    }));
    expect(getIdCallers.callers).toContainEqual(expect.objectContaining({
      caller: expect.stringMatching(/^PatternScope[.]fromInstanceof[.]lambda\d+_\d+$/),
      callee: 'Notebook.getId',
      resolution_kind: 'receiver-type-field',
    }));
    expect(getIdCallers.callers).toContainEqual(expect.objectContaining({
      caller: expect.stringMatching(/^PatternScope[.]fromCast[.]lambda\d+_\d+$/),
      callee: 'Notebook.getId',
      resolution_kind: 'receiver-type-field',
    }));
  });

  it('resolves Java record accessors, Lombok getters, and var-inferred stream lambda receivers', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-java-accessor-streams-');
    writeFile(repo, 'src/test/java/com/example/Folder.java', `package com.example;

public class Folder {
    public Integer getId() {
        return 0;
    }
}
`);
    writeFile(repo, 'src/test/java/com/example/FolderListing.java', `package com.example;

import java.util.List;

public record FolderListing(List<Folder> folders) {
}
`);
    writeFile(repo, 'src/test/java/com/example/FolderScope.java', `package com.example;

public class FolderScope {
    boolean hasFolder(FolderListing listing, Integer needle) {
        return listing.folders().stream()
            .anyMatch(f -> f.getId().equals(needle));
    }
}
`);
    writeFile(repo, 'src/test/java/com/example/UserForListing.java', `package com.example;

public class UserForListing {
    public Integer getId() {
        return 0;
    }
}
`);
    writeFile(repo, 'src/test/java/com/example/UserListingPage.java', `package com.example;

import java.util.List;
import lombok.Getter;

@Getter
public class UserListingPage {
    private List<UserForListing> users;
}
`);
    writeFile(repo, 'src/test/java/com/example/UserScope.java', `package com.example;

public class UserScope {
    boolean containsUser(UserListingPage result, Integer needle) {
        return result.getUsers().stream()
            .anyMatch(u -> u.getId().equals(needle));
    }
}
`);
    writeFile(repo, 'src/test/java/com/example/NoteTopology.java', `package com.example;

public class NoteTopology {
    public Integer getId() {
        return 0;
    }
}
`);
    writeFile(repo, 'src/test/java/com/example/NoteSearchResult.java', `package com.example;

public class NoteSearchResult {
    public NoteTopology getNoteTopology() {
        return new NoteTopology();
    }
}
`);
    writeFile(repo, 'src/test/java/com/example/SearchResult.java', `package com.example;

public class SearchResult {
}
`);
    writeFile(repo, 'src/test/java/com/example/RelationshipLiteralSearchHits.java', `package com.example;

import java.util.List;

public class RelationshipLiteralSearchHits {
    public static List<NoteSearchResult> noteMatches(SearchResult result) {
        return List.of();
    }
}
`);
    writeFile(repo, 'src/test/java/com/example/RelationshipScope.java', `package com.example;

import java.util.List;

public class RelationshipScope {
    List<Integer> noteIds(SearchResult result) {
        var notes = RelationshipLiteralSearchHits.noteMatches(result);
        return notes.stream()
            .map(r -> r.getNoteTopology().getId())
            .toList();
    }
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const folderGetIdCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'Folder.getId', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(folderGetIdCallers.callers).toContainEqual(expect.objectContaining({
      caller: expect.stringMatching(/^FolderScope[.]hasFolder[.]lambda\d+_\d+$/),
      callee: 'Folder.getId',
      resolution_kind: 'receiver-type',
    }));

    const userGetIdCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'UserForListing.getId', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(userGetIdCallers.callers).toContainEqual(expect.objectContaining({
      caller: expect.stringMatching(/^UserScope[.]containsUser[.]lambda\d+_\d+$/),
      callee: 'UserForListing.getId',
      resolution_kind: 'receiver-type',
    }));

    const noteTopologyGetIdCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'NoteTopology.getId', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(noteTopologyGetIdCallers.callers).toContainEqual(expect.objectContaining({
      caller: expect.stringMatching(/^RelationshipScope[.]noteIds[.]lambda\d+_\d+$/),
      callee: 'NoteTopology.getId',
      resolution_kind: 'receiver-type',
    }));
  });

  it('resolves Java stream receiver inference across src/main and src/test roots', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-java-cross-root-streams-');
    writeFile(repo, 'src/main/java/com/example/CatalogItems.java', `package com.example;

public class CatalogItems {
    public void stream() {
    }
}
`);
    writeFile(repo, 'src/main/java/com/example/NotebooksViewedByUser.java', `package com.example;

public class NotebooksViewedByUser {
    public CatalogItems catalogItems = new CatalogItems();
}
`);
    writeFile(repo, 'src/main/java/com/example/Controller.java', `package com.example;

public class Controller {
    public NotebooksViewedByUser myNotebooks() {
        return new NotebooksViewedByUser();
    }
}
`);
    writeFile(repo, 'src/test/java/com/example/ControllerBase.java', `package com.example;

public class ControllerBase {
    protected Controller controller = new Controller();
}
`);
    writeFile(repo, 'src/test/java/com/example/NotebookSharingGroupControllerTest.java', `package com.example;

public class NotebookSharingGroupControllerTest extends ControllerBase {
    void render() {
        var view = controller.myNotebooks();
        view.catalogItems.stream();
    }

    class MyNotebooksCatalog {
        void renderNested() {
            var view = controller.myNotebooks();
            view.catalogItems.stream();
        }
    }
}
`);
    writeFile(repo, 'src/main/java/com/example/UserForListing.java', `package com.example;

public class UserForListing {
    public Integer getId() {
        return 0;
    }
}
`);
    writeFile(repo, 'src/main/java/com/example/UserListingPage.java', `package com.example;

import java.util.List;
import lombok.Getter;

@Getter
public class UserListingPage {
    private List<UserForListing> users;
}
`);
    writeFile(repo, 'src/test/java/com/example/AdminUserControllerTest.java', `package com.example;

public class AdminUserControllerTest {
    boolean hasUser(UserListingPage result, Integer needle) {
        return result.getUsers().stream()
            .anyMatch(u -> u.getId().equals(needle));
    }
}
`);
    writeFile(repo, 'src/main/java/com/example/Folder.java', `package com.example;

public class Folder {
    public Integer getId() {
        return 0;
    }
}
`);
    writeFile(repo, 'src/main/java/com/example/FolderRepository.java', `package com.example;

import java.util.List;

public class FolderRepository {
    public List<Folder> findCandidateChildContainers() {
        return List.of();
    }
}
`);
    writeFile(repo, 'src/main/java/com/example/FolderService.java', `package com.example;

public class FolderService {
    private final FolderRepository folderRepository = new FolderRepository();

    boolean hasConflict(Integer needle) {
        return folderRepository.findCandidateChildContainers().stream()
            .anyMatch(f -> f.getId().equals(needle));
    }
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const streamCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'CatalogItems.stream', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(streamCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'NotebookSharingGroupControllerTest.render',
      callee: 'CatalogItems.stream',
      resolution_kind: 'receiver-type-field',
    }));
    expect(streamCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'MyNotebooksCatalog.renderNested',
      callee: 'CatalogItems.stream',
      resolution_kind: 'receiver-type-field',
    }));

    const userGetIdCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'UserForListing.getId', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(userGetIdCallers.callers).toContainEqual(expect.objectContaining({
      caller: expect.stringMatching(/^AdminUserControllerTest[.]hasUser[.]lambda\d+_\d+$/),
      callee: 'UserForListing.getId',
      resolution_kind: 'receiver-type',
    }));

    const folderGetIdCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'Folder.getId', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(folderGetIdCallers.callers).toContainEqual(expect.objectContaining({
      caller: expect.stringMatching(/^FolderService[.]hasConflict[.]lambda\d+_\d+$/),
      callee: 'Folder.getId',
      resolution_kind: 'receiver-type',
    }));
  });

  it('indexes TypeScript and Python callback references and inline callback bodies', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-script-callback-refs-');
    writeFile(repo, 'src/ui.ts', `class EventBus {
  on(name: string, handler: (...args: unknown[]) => void) {}
}

class UiController {
  mount(bus: EventBus) {
    bus.on('click', this.handleClick);
    bus.on('hover', () => this.handleHover());
    bus.on('focus', function () { console.log('noop'); });
    this.callback = this.handleAssigned;
  }

  handleClick() {}

  handleHover() {}

  handleAssigned() {}
}
`);
    writeFile(repo, 'src/worker.py', `class Scheduler:
    def on_done(self, callback):
        pass

    def run_async(self, callback):
        pass


class Worker:
    def register(self, scheduler: Scheduler):
        scheduler.on_done(self.handle_done)
        scheduler.run_async(lambda: self.handle_inline())
        self.callback = self.handle_assigned

    def handle_done(self):
        pass

    def handle_assigned(self):
        pass

    def handle_inline(self):
        pass
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const tsCallbackRefCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'UiController.handleClick', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(tsCallbackRefCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'UiController.mount',
      callee: 'UiController.handleClick',
      resolution_kind: 'callback-reference',
    }));

    const tsInlineCallbackCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'UiController.handleHover', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string }> };
    expect(tsInlineCallbackCallers.callers).toContainEqual(expect.objectContaining({
      caller: expect.stringMatching(/^UiController[.]mount[.]lambda\d+_\d+$/),
      callee: 'UiController.handleHover',
    }));

    const tsAssignedCallbackCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'UiController.handleAssigned', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(tsAssignedCallbackCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'UiController.mount',
      callee: 'UiController.handleAssigned',
      resolution_kind: 'callback-reference',
    }));

    const tsCallbackEdges = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callees',
      args: { symbol: 'UiController.mount', includeLowSignal: true },
    }) as { callees: Array<{ callee: string; resolution_kind: string }> };
    expect(tsCallbackEdges.callees).toContainEqual(expect.objectContaining({
      callee: expect.stringMatching(/^UiController[.]mount[.]lambda\d+_\d+$/),
      resolution_kind: 'lambda-callback',
    }));

    const pyCallbackRefCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'Worker.handle_done', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(pyCallbackRefCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'Worker.register',
      callee: 'Worker.handle_done',
      resolution_kind: 'callback-reference',
    }));

    const pyInlineCallbackCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'Worker.handle_inline', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string }> };
    expect(pyInlineCallbackCallers.callers).toContainEqual(expect.objectContaining({
      caller: expect.stringMatching(/^Worker[.]register[.]lambda\d+_\d+$/),
      callee: 'Worker.handle_inline',
    }));

    const pyAssignedCallbackCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'Worker.handle_assigned', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(pyAssignedCallbackCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'Worker.register',
      callee: 'Worker.handle_assigned',
      resolution_kind: 'callback-reference',
    }));

    const pyCallbackEdges = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callees',
      args: { symbol: 'Worker.register', includeLowSignal: true },
    }) as { callees: Array<{ callee: string; resolution_kind: string }> };
    expect(pyCallbackEdges.callees).toContainEqual(expect.objectContaining({
      callee: expect.stringMatching(/^Worker[.]register[.]lambda\d+_\d+$/),
      resolution_kind: 'lambda-callback',
    }));
  });

  it('indexes bare callable identifiers used as callback values', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-script-bare-callback-');
    writeFile(repo, 'src/handlers.ts', `export function sharedHandler(payload: string) {}
`);
    writeFile(repo, 'src/ui.ts', `import { sharedHandler } from './handlers';

class EventBus {
  on(name: string, callback: (payload: string) => void) {}
}

function localHandler(payload: string) {}

class UiController {
  mount(bus: EventBus) {
    bus.on('submit', localHandler);
    bus.on('import', sharedHandler);
  }
}`);
    writeFile(repo, 'src/worker.py', `from typing import Any

def top_handler(event: Any):
    pass

from hooks import external_handler

class Worker:
    def register(self, scheduler: Any):
        scheduler.on_done(top_handler)
        scheduler.on_done(external=external_handler)
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({ root: repo });
    const queries = new V2QueryService(db);

    const tsLocalCallbackCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'localHandler', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(tsLocalCallbackCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'UiController.mount',
      callee: 'localHandler',
      resolution_kind: 'callback-reference',
    }));

    const tsImportedCallbackCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'sharedHandler', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(tsImportedCallbackCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'UiController.mount',
      callee: 'sharedHandler',
      resolution_kind: 'callback-reference',
    }));

    const pyLocalCallbackCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'top_handler', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(pyLocalCallbackCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'Worker.register',
      callee: 'top_handler',
      resolution_kind: 'callback-reference',
    }));

    const pyImportedCallbackCallers = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'external_handler', includeLowSignal: true },
    }) as { callers: Array<{ caller: string; callee: string; resolution_kind: string }> };
    expect(pyImportedCallbackCallers.callers).toContainEqual(expect.objectContaining({
      caller: 'Worker.register',
      callee: 'external_handler',
      resolution_kind: 'callback-reference',
    }));
  });

  it('writes parse context and empty-safe fact shards when result spooling is disabled', () => {
    const repo = tempDir('codegraph-shard-files-');
    writeFile(repo, 'src/main/java/com/example/One.java', `package com.example;

public class One {
}
`);
    writeFile(repo, 'src/main/java/com/example/Two.java', `package com.example;

public class Two {
}
`);
    const workItems: ParseWorkItem[] = [
      {
        key: 'src/main/java/com/example/One.java',
        absPath: path.join(repo, 'src/main/java/com/example/One.java'),
        rootDir: repo,
        size: 32,
        blobHash: 'one-hash',
        language: 'java',
        role: 'main_source',
      },
      {
        key: 'src/main/java/com/example/Two.java',
        absPath: path.join(repo, 'src/main/java/com/example/Two.java'),
        rootDir: repo,
        size: 32,
        blobHash: 'two-hash',
        language: 'java',
        role: 'main_source',
      },
    ];

    const spool = parseFilesBatchToSpool(workItems, {
      workers: 1,
      spoolResults: false,
      factShard: {
        snapshotId: 'snapshot-test',
        providerId: 'tree-sitter',
        providerVersion: 'test',
        createdAt: new Date(0).toISOString(),
      },
    });

    try {
      expect(spool.shardPaths).toEqual([]);
      expect(spool.contextShardPaths).toHaveLength(1);
      expect(fs.existsSync(spool.contextShardPaths[0]!)).toBe(true);
      expect([...readParseContextItemsJsonl(spool.contextShardPaths[0]!)]).toHaveLength(2);
      expect(spool.factShardPaths).toHaveLength(1);
      for (const filePath of Object.values(spool.factShardPaths[0]!)) {
        expect(fs.existsSync(filePath)).toBe(true);
      }
      expect(spool.factStatsByShard).toHaveLength(1);
      expect(spool.factStats.parseCache).toBe(2);
      expect(() => [...readParseContextItemsJsonl(path.join(repo, 'missing.context.json'))])
        .toThrow(/Missing parse context shard/);
    } finally {
      spool.close();
    }
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

  it('ignores .codegraph artifacts when checking git freshness for warm reindex', async () => {
    if (!hasGit()) return;

    const repo = tempDir('codegraph-git-clean-warm-');
    runGit(repo, 'init');
    runGit(repo, 'config', 'user.email', 'codegraph@example.test');
    runGit(repo, 'config', 'user.name', 'CodeGraph Test');
    writeFile(repo, 'src/main/java/com/example/Demo.java', `package com.example;

public class Demo {
    public void run() {
    }
}
`);
    runGit(repo, 'add', '.');
    runGit(repo, 'commit', '-m', 'initial');

    const opened = await openCodeGraphDb(repo);
    dbs.push(opened.db);
    const indexer = new V2Indexer(opened.db);

    const first = await indexer.indexWorkspace({ root: repo });
    expect(fs.existsSync(path.join(repo, '.codegraph', 'graph.sqlite'))).toBe(true);

    const second = await indexer.indexWorkspace({ root: repo });
    expect(first.filesParsed).toBeGreaterThan(0);
    expect(second.filesParsed).toBe(0);
    expect(second.parseCacheHits).toBe(second.filesTotal);
    expect(second.filesChanged).toBe(0);
    expect(second.skippedUnchanged).toBe(true);
  });

  it('hydrates sharded full facts from parse cache for a new workspace key', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-sharded-cache-hydrate-');
    writeFile(repo, 'src/main/java/com/example/PaymentGateway.java', `package com.example;

public class PaymentGateway {
    public void processPayment() {
    }
}
`);
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
    private final PaymentGateway gateway = new PaymentGateway();

    public void submit() {
        gateway.processPayment();
    }
}
`);

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const first = await indexer.indexWorkspace({ root: repo, workspaceKey: 'cache-hydrate-a' });
    const second = await indexer.indexWorkspace({ root: repo, workspaceKey: 'cache-hydrate-b' });
    const queries = new V2QueryService(db);

    expect(first.filesParsed).toBeGreaterThan(0);
    expect(second.parseCacheHits).toBeGreaterThan(0);
    expect(second.filesParsed).toBe(0);
    expect(second.skippedUnchanged).toBe(false);

    const search = await queries.query({
      workspaceId: second.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'PaymentService', limit: 5 },
    }) as { symbols: Array<{ name: string }> };
    expect(search.symbols.some(symbol => symbol.name === 'PaymentService')).toBe(true);

    const callers = await queries.query({
      workspaceId: second.workspaceId,
      toolName: 'get_callers',
      args: { symbol: 'PaymentGateway.processPayment' },
    }) as { callers: Array<{ caller: string; resolution_kind: string }> };
    expect(callers.callers).toContainEqual(expect.objectContaining({
      caller: 'PaymentService.submit',
      resolution_kind: 'receiver-field',
    }));
  });

  it('imports SCIP provider facts and scopes parse cache by provider metadata', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-scip-provider-');
    const javaFile = 'src/main/java/com/example/Placeholder.java';
    writeFile(repo, javaFile, `package com.example;

public class Placeholder {
    public void realMethod() {
    }
}
`);
    writeFile(repo, 'index.scip.json', JSON.stringify({
      documents: [{
        relativePath: javaFile,
        language: 'java',
        symbols: [
          {
            symbol: 'com.example.ScipOnlyFeature',
            displayName: 'ScipOnlyFeature',
            kind: 'Class',
            signatureDocumentation: { text: 'public class ScipOnlyFeature' },
          },
          {
            symbol: 'com.example.ScipOnlyFeature#indexedAction().',
            displayName: 'indexedAction',
            kind: 'Method',
            enclosingSymbol: 'com.example.ScipOnlyFeature',
            signatureDocumentation: { text: 'public void indexedAction()' },
          },
        ],
        occurrences: [
          {
            symbol: 'com.example.ScipOnlyFeature',
            symbolRoles: 1,
            range: [2, 13, 24],
            enclosingRange: [2, 0, 5, 1],
          },
          {
            symbol: 'com.example.ScipOnlyFeature#indexedAction().',
            symbolRoles: 1,
            range: [3, 16, 26],
            enclosingRange: [3, 4, 4, 5],
          },
          {
            symbol: 'com.example.ExternalDependency#externalWork().',
            symbolRoles: 0,
            range: [3, 28, 40],
            enclosingRange: [3, 4, 4, 5],
          },
        ],
      }],
    }, null, 2));

    const { db } = await openDb(home);
    const indexer = new V2Indexer(db);
    const result = await indexer.indexWorkspace({
      root: repo,
      indexProviders: 'tree-sitter,scip',
      scipIndexPath: 'index.scip.json',
    });

    expect(result.indexProviderIds).toEqual(['tree-sitter', 'scip']);

    const queries = new V2QueryService(db);
    const stats = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'get_index_stats',
      args: {},
    }) as { snapshot: { index_provider_ids: string; index_provider_versions_json: string } };
    expect(stats.snapshot.index_provider_ids).toBe('tree-sitter,scip');
    expect(JSON.parse(stats.snapshot.index_provider_versions_json)).toHaveProperty('scip');

    const scipSymbol = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'ScipOnlyFeature', kind: 'class', limit: 10 },
    }) as { symbols: Array<{ name: string; fqName: string }> };
    expect(scipSymbol.symbols).toContainEqual(expect.objectContaining({
      name: 'ScipOnlyFeature',
      fqName: 'ScipOnlyFeature',
    }));

    const scipReferences = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'find_references',
      args: { symbol: 'externalWork', kind: 'call', limit: 10 },
    }) as { references: Array<{ kind: string; resolutionKind?: string; confidence?: number }> };
    expect(scipReferences.references).toContainEqual(expect.objectContaining({
      kind: 'call',
      resolutionKind: 'scip-reference',
      confidence: 0.9,
    }));

    const cacheRows = await db.prepare(`
      SELECT provider_id, COUNT(*) AS count
      FROM parse_cache
      GROUP BY provider_id
    `).all() as Array<{ provider_id: string; count: string }>;
    expect(Number(cacheRows.find(row => row.provider_id === 'tree-sitter+scip')?.count ?? 0)).toBeGreaterThan(0);

    const warm = await indexer.indexWorkspace({
      root: repo,
      indexProviders: ['tree-sitter', 'scip'],
      scipIndexPath: 'index.scip.json',
    });
    expect(warm.skippedUnchanged).toBe(true);
    expect(warm.parseCacheHits).toBe(warm.filesTotal);

    const treeOnly = await indexer.indexWorkspace({ root: repo, indexProviders: 'tree-sitter' });
    expect(treeOnly.indexProviderIds).toEqual(['tree-sitter']);
    expect(treeOnly.skippedUnchanged).toBe(false);
    expect(treeOnly.filesParsed).toBeGreaterThan(0);

    const treeOnlySearch = await queries.query({
      workspaceId: result.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'ScipOnlyFeature', kind: 'class', limit: 10 },
    }) as { symbols: Array<{ name: string }> };
    expect(treeOnlySearch.symbols.some(symbol => symbol.name === 'ScipOnlyFeature')).toBe(false);
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
    expect(await db.scalar('SELECT files FROM snapshot_stats WHERE snapshot_id = ?', third.snapshotId)).toBe(1);

    const deletedSearch = await queries.query({
      workspaceId: third.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'Keep', limit: 5 },
    }) as { symbols: Array<{ name: string }> };
    expect(deletedSearch.symbols.some(symbol => symbol.name === 'Keep')).toBe(false);
  });

  it('refreshes specific changed paths without a full manifest scan', async () => {
    const home = tempDir('codegraph-home-');
    const repo = tempDir('codegraph-path-delta-');
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

public class PathDeltaFeature {
}
`);
    const second = await indexer.refreshWorkspacePaths({
      root: repo,
      changedPaths: ['src/main/java/com/example/Feature.java'],
    });

    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.pathDeltaUpdated).toBe(true);
    expect(second.incrementalUpdated).toBe(true);
    expect(second.filesChanged).toBe(1);
    expect(second.filesDeleted).toBe(0);
    expect(second.filesTotal).toBe(2);

    const queries = new V2QueryService(db);
    const changedSearch = await queries.query({
      workspaceId: second.workspaceId,
      toolName: 'search_symbol',
      args: { query: 'PathDeltaFeature', limit: 5 },
    }) as { symbols: Array<{ name: string }> };
    expect(changedSearch.symbols.some(symbol => symbol.name === 'PathDeltaFeature')).toBe(true);

    fs.rmSync(path.join(repo, 'src/main/java/com/example/Keep.java'));
    const third = await indexer.refreshWorkspacePaths({
      root: repo,
      changedPaths: [path.join(repo, 'src/main/java/com/example/Keep.java')],
    });
    expect(third.pathDeltaUpdated).toBe(true);
    expect(third.filesDeleted).toBe(1);
    expect(third.filesTotal).toBe(1);

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

function tsxArgs(args: string[]): string[] {
  return [path.resolve('node_modules', 'tsx', 'dist', 'cli.mjs'), ...args];
}
