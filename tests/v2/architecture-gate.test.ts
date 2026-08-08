import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('architecture gate', () => {
  it('passes the repository structural boundaries', () => {
    const output = execFileSync(process.execPath, ['scripts/architecture-gate.mjs'], {
      encoding: 'utf8',
    });
    expect(JSON.parse(output)).toMatchObject({ ok: true });
  });
});
