import { describe, expect, it } from 'vitest';
import { queryTelemetryForLog } from '../../src/v2/daemon/server.js';

describe('daemon query telemetry', () => {
  it('summarizes token estimates, follow-up calls, and quality signals', () => {
    const telemetry = queryTelemetryForLog(
      'get_change_pack',
      { task: 'debug payment refund', tokenBudget: 4000 },
      {
        routing: {
          firstToolCall: {
            tool: 'get_file_slice',
          },
        },
        taskOracle: {
          expectedVerification: { commands: ['npm test'] },
          goldenFacts: [{ kind: 'file', value: 'src/payment.ts' }],
        },
        testsLikelyRelevant: [{ file: 'src/payment.test.ts' }],
        validation: { suggestedCommands: ['npm test'] },
        compressedEvidence: { factCards: [] },
      },
      123,
    );

    expect(telemetry).toMatchObject({
      durationMs: 123,
      responseSize: 'small',
      followUpToolCallCount: 1,
      toolHintCount: 1,
      hasTaskOracle: true,
      hasExpectedVerification: true,
      hasCompressedEvidence: true,
    });
    expect(telemetry.estimatedInputTokens).toBeGreaterThan(0);
    expect(telemetry.estimatedOutputTokens).toBeGreaterThan(0);
    expect(telemetry.resultQualitySignals).toMatchObject({
      hasValidation: true,
      hasLikelyTests: true,
      hasGoldenFacts: true,
    });
  });
});
