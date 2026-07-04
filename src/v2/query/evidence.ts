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

export type TrustPosture = 'act_directly' | 'spot_check_recommended';

const VERIFY_BUDGET_CONFIDENCE_THRESHOLD = 0.5; // matches search-filters.ts, service.ts confidence>=0.5 gates
const VERIFY_BUDGET_MAX_ITEMS = 3;

export interface VerifyBudgetItem {
  fact: string;
  file: string | undefined;
  line: number | string | undefined;
  confidence: number | undefined;
  resolutionKind: string | undefined;
  signalTier: string | undefined;
  reason: string;
  verify: Record<string, unknown> | undefined;
}

/**
 * Scans the already-capped, returned flowSteps for kind==='call' steps whose
 * confidence is low enough that the agent should not blindly trust them even
 * though the pack overall is answerable. signalTier==='provider' is excluded
 * by construction: it is the SCIP-resolved, highest-trust tier (confidence
 * forced >= 0.9), never a low-confidence edge.
 */
export function verifyBudgetForFlowSteps(
  returnedFlowSteps: Array<Record<string, unknown>>,
  maxItems: number = VERIFY_BUDGET_MAX_ITEMS,
): VerifyBudgetItem[] {
  const candidates = returnedFlowSteps.filter(step => {
    if (step.kind !== 'call') return false;
    if (step.signalTier === 'provider') return false;
    const confidence = typeof step.confidence === 'number' ? step.confidence : undefined;
    const lowConfidence = typeof confidence === 'number' && confidence < VERIFY_BUDGET_CONFIDENCE_THRESHOLD;
    return lowConfidence || step.signalTier === 'low_signal';
  });
  return candidates
    .sort((a, b) => Number(a.confidence ?? 0) - Number(b.confidence ?? 0))
    .slice(0, maxItems)
    .map(step => {
      const confidence = typeof step.confidence === 'number' ? step.confidence : undefined;
      const reasonParts: string[] = [];
      if (typeof confidence === 'number' && confidence < VERIFY_BUDGET_CONFIDENCE_THRESHOLD) {
        reasonParts.push(`confidence ${confidence.toFixed(2)} < ${VERIFY_BUDGET_CONFIDENCE_THRESHOLD}`);
      }
      if (step.signalTier === 'low_signal') reasonParts.push('low_signal edge');
      if (step.resolutionKind === 'name-only') reasonParts.push('ambiguous name-only match');
      return {
        fact: String(step.summary ?? ''),
        file: stringOrUndefined(step.file),
        line: (step.line as number | string | undefined) ?? stringOrUndefined(step.lines),
        confidence,
        resolutionKind: stringOrUndefined(step.resolutionKind),
        signalTier: stringOrUndefined(step.signalTier),
        reason: reasonParts.join('; ') || 'flagged for low trust',
        verify: evidenceHandleForObject(step),
      };
    });
}

/**
 * Returns undefined when the pack is not sufficientForAnswer: that branch
 * already has its own verification contract (missingFacts/allowedFollowups/
 * stopRule) and a second, competing trust signal would only add confusion.
 */
export function trustPostureFor(sufficientForAnswer: boolean, verifyBudgetLength: number): TrustPosture | undefined {
  if (!sufficientForAnswer) return undefined;
  return verifyBudgetLength > 0 ? 'spot_check_recommended' : 'act_directly';
}
