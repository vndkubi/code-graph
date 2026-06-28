/**
 * Pack profile sizing. `micro`/`compact`/`full` select how much evidence a pack
 * returns; packProfileValue picks the per-profile value for a given budget knob.
 * Extracted from service.ts as part of breaking up the monolith.
 */
export type PackProfile = 'micro' | 'compact' | 'full';

export function normalizePackProfile(value: unknown, fallback: PackProfile = 'compact'): PackProfile {
  const profile = String(value ?? '').trim().toLowerCase();
  if (profile === 'micro' || profile === 'compact' || profile === 'full') return profile;
  return fallback;
}

export function packProfileValue(profile: PackProfile, micro: number, compact: number, full: number): number {
  if (profile === 'micro') return micro;
  if (profile === 'full') return full;
  return compact;
}
