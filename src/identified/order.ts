import type { SignalContribution } from "./index.js";

/** UTF-16 code unit order: the same on every machine and locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sort order for `EntityScore.contributions`: heaviest first; equal weights
 * by id, tier, source, proof (ascending), then age (youngest first, unknown
 * age last). The order depends only on the contributions themselves, never on
 * the order the signals were supplied in. Internal: not exported from the
 * package.
 */
export function compareContributions(a: SignalContribution, b: SignalContribution): number {
  if (a.weight !== b.weight) return b.weight - a.weight;
  const ageA = a.ageDays ?? Infinity;
  const ageB = b.ageDays ?? Infinity;
  return (
    compareText(a.id, b.id) ||
    compareText(a.tier, b.tier) ||
    compareText(a.source, b.source) ||
    compareText(a.proof, b.proof) ||
    (ageA < ageB ? -1 : ageA > ageB ? 1 : 0)
  );
}
