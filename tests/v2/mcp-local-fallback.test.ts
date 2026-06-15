import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLocalArtifactIndex } from '../../src/v2/mcp/local-artifact.js';
import { localCodeGraphContext, localCodeGraphSlice } from '../../src/v2/mcp/local-fallback.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('MCP local filesystem fallback', () => {
  it('returns useful degraded context without a database runtime', async () => {
    const repo = tempDir('codegraph-local-fallback-');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void refundPayment() {
  }
}
`);
    writeFile(repo, 'src/test/java/com/example/PaymentServiceTest.java', `package com.example;

public class PaymentServiceTest {
  public void refundPaymentUsesGateway() {
  }
}
`);

    const result = await localCodeGraphContext(repo, {
      task: 'Find the PaymentService refundPayment implementation and likely tests.',
      profile: 'compact',
    }, { error: { code: 'runtime_unavailable' } });

    expect(result.degraded).toBe(true);
    expect(result.source).toBe('local_filesystem_fallback');
    expect(result.topFiles[0]).toBe('src/main/java/com/example/PaymentService.java');
    expect(JSON.stringify(result)).toContain('refundPayment');
    expect(result.scan?.filesRead).toBeGreaterThan(0);
  });

  it('uses the embedded artifact index when setup has run', async () => {
    const repo = tempDir('codegraph-local-artifact-repo-');
    writeFile(repo, 'src/main/java/com/example/PaymentService.java', `package com.example;

public class PaymentService {
  public void refundPayment() {
  }
}
`);
    writeFile(repo, 'src/test/java/com/example/PaymentServiceTest.java', `package com.example;

public class PaymentServiceTest {
  public void refundPaymentUsesGateway() {
  }
}
`);

    const setup = await buildLocalArtifactIndex(repo);
    expect(setup.backend).toBe('embedded-artifact');
    expect(setup.filesIndexed).toBeGreaterThan(0);

    const result = await localCodeGraphContext(repo, {
      task: 'Find the PaymentService refundPayment implementation and likely tests.',
      profile: 'compact',
    }, { error: { code: 'runtime_unavailable' } });

    expect(result.degraded).toBe(true);
    expect(result.source).toBe('local_artifact_index');
    expect(result.topFiles[0]).toBe('src/main/java/com/example/PaymentService.java');
    expect(JSON.stringify(result)).toContain('refundPayment');
    expect(result.scan?.artifactPath).toBe(setup.artifactPath);
    expect(result.scan?.filesRead).toBeLessThanOrEqual(result.evidenceSlices.length);
  });

  it('skips temporary dot directories during artifact setup', async () => {
    const repo = tempDir('codegraph-local-artifact-skip-repo-');
    writeFile(repo, 'src/main/java/com/example/RealProxy.java', `package com.example;

public class RealProxy {
  public void setupArtifact() {
  }
}
`);
    writeFile(repo, '.tmp-debug-home/old-copy/src/main/java/com/example/RealProxy.java', `package com.example;

public class RealProxy {
  public void setupArtifact() {
  }
}
`);

    const setup = await buildLocalArtifactIndex(repo);
    expect(setup.filesIndexed).toBe(1);

    const result = await localCodeGraphContext(repo, {
      task: 'Find setupArtifact RealProxy implementation.',
      profile: 'compact',
    }, { error: { code: 'runtime_unavailable' } });

    expect(result.source).toBe('local_artifact_index');
    expect(result.topFiles).toEqual(['src/main/java/com/example/RealProxy.java']);
    expect(JSON.stringify(result)).not.toContain('.tmp-debug-home');
  });

  it('prioritizes explicit diff paths from the embedded artifact', async () => {
    const repo = tempDir('codegraph-local-artifact-diff-repo-');
    writeFile(repo, 'src/main/java/com/example/TargetService.java', `package com.example;

public class TargetService {
  public void applicationTags() {
  }
}
`);
    writeFile(repo, 'src/main/java/com/example/NoisyApplicationTags.java', `package com.example;

public class NoisyApplicationTags {
  public void applicationTags() {
  }
}
`);

    await buildLocalArtifactIndex(repo);
    const result = await localCodeGraphContext(repo, {
      task: 'Review this diff for applicationTags regression.',
      diff: 'diff --git a/src/main/java/com/example/TargetService.java b/src/main/java/com/example/TargetService.java\n@@\n- old\n+ new\n',
      profile: 'full',
    }, { error: { code: 'runtime_unavailable' } });

    expect(result.source).toBe('local_artifact_index');
    expect(result.topFiles).toEqual(['src/main/java/com/example/TargetService.java']);
    expect(result.scan?.filesMatched).toBe(1);
  });

  it('keeps indexing content terms after the artifact symbol cap', async () => {
    const repo = tempDir('codegraph-local-artifact-cap-repo-');
    const methods = Array.from({ length: 90 }, (_, index) => `  public void method${index}() {
  }
`).join('\n');
    writeFile(repo, 'src/main/java/com/example/BulkService.java', `package com.example;

public class BulkService {
${methods}
}
`);

    await buildLocalArtifactIndex(repo);
    const result = await localCodeGraphContext(repo, {
      task: 'Find method84 implementation.',
      profile: 'compact',
    }, { error: { code: 'runtime_unavailable' } });

    expect(result.source).toBe('local_artifact_index');
    expect(result.topFiles[0]).toBe('src/main/java/com/example/BulkService.java');
    expect(JSON.stringify(result)).toContain('method84');
  });

  it('slices a file or symbol from local source', async () => {
    const repo = tempDir('codegraph-local-slice-');
    writeFile(repo, 'src/main/java/com/example/InventoryService.java', `package com.example;

public class InventoryService {
  public void reserveStock() {
  }
}
`);

    const byFile = await localCodeGraphSlice(repo, {
      file: 'src/main/java/com/example/InventoryService.java',
      lines: '3-4',
      maxChars: 1000,
    });
    expect(byFile.slice?.text).toContain('InventoryService');

    const bySymbol = await localCodeGraphSlice(repo, {
      symbol: 'reserveStock',
      maxChars: 1000,
    });
    expect(bySymbol.slice?.file).toBe('src/main/java/com/example/InventoryService.java');
    expect(bySymbol.slice?.text).toContain('reserveStock');
  });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, relPath: string, contents: string): void {
  const filePath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}
