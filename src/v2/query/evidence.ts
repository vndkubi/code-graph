/**
 * Evidence-slice and follow-up-handle shaping for packs. Extracted from
 * service.ts; pure functions over already-fetched rows.
 */
import { stringOrUndefined, truncateOptional } from './util.js';
import { PackProfile, packProfileValue } from './pack-profile.js';

export function evidenceHandleForObject(value: Record<string, unknown>, maxChars = 3000): Record<string, unknown> | undefined {
  const file = stringOrUndefined(value.file);
  const lines = stringOrUndefined(value.fileSliceLines ?? value.lines ?? value.newLines);
  const symbol = stringOrUndefined(value.symbol);
  if (!file && !symbol) return undefined;
  const args: Record<string, unknown> = { maxChars };
  if (file) args.file = file;
  if (lines) args.lines = lines;
  if (symbol) args.symbol = symbol;
  return {
    tool: 'get_file_slice',
    args,
    source: stringOrUndefined(value.targetId) ?? stringOrUndefined(value.why) ?? stringOrUndefined(value.whyRelevant),
  };
}

export function evidenceHandlesForObjects(values: Array<Record<string, unknown>>, profile: PackProfile, maxChars?: number): Array<Record<string, unknown>> {
  const limit = packProfileValue(profile, 4, 6, 12);
  const charLimit = maxChars ?? packProfileValue(profile, 1800, 2600, 5000);
  const seen = new Set<string>();
  const handles: Array<Record<string, unknown>> = [];
  for (const value of values) {
    const handle = evidenceHandleForObject(value, charLimit);
    if (!handle) continue;
    const key = JSON.stringify(handle.args);
    if (seen.has(key)) continue;
    seen.add(key);
    handles.push(handle);
    if (handles.length >= limit) break;
  }
  return handles;
}

export function slimEvidenceSlicesForPack(slices: Array<Record<string, unknown>>, profile: PackProfile): Array<Record<string, unknown>> {
  if (profile === 'full') return slices;
  const limit = profile === 'micro' ? 2 : 3;
  const textLimit = profile === 'micro' ? 320 : 560;
  return slices.slice(0, limit).map(slice => ({
    file: String(slice.file ?? ''),
    lines: stringOrUndefined(slice.lines),
    symbol: stringOrUndefined(slice.symbol),
    why: truncateOptional(slice.why, profile === 'micro' ? 100 : 150),
    text: truncateOptional(slice.text, textLimit),
    truncated: Boolean(slice.truncated),
    confidence: typeof slice.confidence === 'number' ? slice.confidence : undefined,
  }));
}
