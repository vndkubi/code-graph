import { describe, expect, it } from 'vitest';
import type { ParseResult } from '../../src/analyzers/base-analyzer.js';
import { decodeParseCachePayload, encodeParseCachePayload } from '../../src/v2/index/parse-cache-codec.js';

describe('parse cache payload codec', () => {
  it('compresses large parse cache payloads and decodes them losslessly', () => {
    const result = parseResultWithLargePayload();
    const rawJson = JSON.stringify(result);
    const encoded = encodeParseCachePayload(result);

    expect(encoded.startsWith('gz64:')).toBe(true);
    expect(encoded.length).toBeLessThan(rawJson.length);
    expect(decodeParseCachePayload(encoded)).toEqual(result);
  });

  it('keeps backwards compatibility with plain JSON parse cache rows', () => {
    const result = parseResultWithLargePayload();
    expect(decodeParseCachePayload(JSON.stringify(result))).toEqual(result);
  });
});

function parseResultWithLargePayload(): ParseResult {
  return {
    file: 'src/main/java/com/example/Large.java',
    symbols: [
      {
        name: 'Large',
        fqName: 'Large',
        kind: 'class',
        file: 'src/main/java/com/example/Large.java',
        line: 1,
        column: 1,
        endLine: 500,
        signature: `class Large { ${'x'.repeat(32_000)} }`,
        visibility: 'public',
        module: 'src/main/java',
      },
    ],
    imports: [],
    calls: Array.from({ length: 500 }, (_, index) => ({
      caller: 'Large.run',
      callee: `Target${index % 20}.handle`,
      file: 'src/main/java/com/example/Large.java',
      line: index + 2,
      confidence: 0.8,
      resolutionKind: 'receiver-type',
    })),
    references: [],
    hasParseErrors: false,
    parseConfidence: 1,
  };
}
