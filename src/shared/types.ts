/**
 * trust-core/shared — the small toolkit both scoring modules are built from.
 *
 * `identified/` (known contributors) and `anonymous/` (unattributed, scraped
 * signals) answer different questions, but they lean on the same primitives:
 * a weight, a recency-decay curve, a shrink-toward-a-baseline move, and a
 * confidence label derived from how much credible evidence there was. Keeping
 * those primitives here — instead of copy-pasted into each module — is what
 * makes the two modules "one library" rather than two unrelated files.
 *
 * Pure, deterministic, dependency-free: no Date.now(), no I/O, no randomness.
 * Every function takes whatever "now" it needs as an explicit ISO string.
 */

import { checkNumber, deepFreeze, hasOwn, show } from "./internal.js";

// ---------------------------------------------------------------------------
// Bounding
// ---------------------------------------------------------------------------

/** Clamp `value` into `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Clamp `value` into `[0, 1]`. The unit interval both modules compute in. */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

// ---------------------------------------------------------------------------
// Weight
// ---------------------------------------------------------------------------

/**
 * A signal's intrinsic credibility, as a non-negative multiplier. Weights are
 * combined multiplicatively (tier x source x proof x ...) and summed across
 * signals to produce an effective sample size — a credibility-weighted count,
 * not a raw one.
 */
export type Weight = number;

// ---------------------------------------------------------------------------
// Recency decay
// ---------------------------------------------------------------------------

/** Whole days between two ISO timestamps (`toISO` minus `fromISO`). Can be negative. */
export function daysBetween(fromISO: string, toISO: string): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return (Date.parse(toISO) - Date.parse(fromISO)) / MS_PER_DAY;
}

/**
 * Exponential recency decay: a multiplier in `(0, 1]` that halves every
 * `halfLifeDays`. Both modules use this — identified signals decay by how
 * long ago the underlying event happened; anonymous signals decay by how
 * long ago the material was published.
 */
export function recencyDecay(ageDays: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return ageDays <= 0 ? 1 : 0;
  return Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
}

// ---------------------------------------------------------------------------
// Shrinkage toward a prior
// ---------------------------------------------------------------------------

/**
 * Pull a weighted mean toward `prior` by shrinkage strength `dial`, expressed
 * in "phantom prior signals": the result is as if `dial` average-credibility
 * signals had already voted for `prior`.
 *
 *   shrunk = (weightedSum + dial * prior) / (totalWeight + dial)
 *
 * With `totalWeight = 0` this collapses to `prior` exactly (no divide-by-zero,
 * no evidence still yields a defined score). As `totalWeight` grows past
 * `dial`, the result converges on the unshrunk weighted mean.
 */
export function shrinkTowardPrior(
  weightedSum: number,
  totalWeight: number,
  prior: number,
  dial: number,
): number {
  return (weightedSum + dial * prior) / (totalWeight + dial);
}

/**
 * Named shrinkage presets ("the trust dial"). `C` is the `dial` strength fed
 * to {@link shrinkTowardPrior}. A caller is never limited to these three —
 * anywhere a dial is accepted, a raw number works too.
 */
export type TrustDialPreset = "as_is" | "balanced" | "strict";

export interface TrustDial {
  /** Shrinkage strength, in phantom prior signals. */
  C: number;
  label: string;
  description: string;
}

export const TRUST_DIALS: Record<TrustDialPreset, TrustDial> = deepFreeze({
  as_is: {
    C: 0.5,
    label: "As-is",
    description:
      "Trust the credibility-weighted average with almost no shrinkage (a hair of pull avoids a bare 0-signal blow-up).",
  },
  balanced: {
    C: 4,
    label: "Balanced",
    description: "Pull thin evidence gently toward the baseline. Sensible default.",
  },
  strict: {
    C: 12,
    label: "Strict",
    description: "Demand deep, credible evidence before a score is allowed to stand on its own.",
  },
});

/**
 * Resolve a dial preset name (or a raw `C` number) to its numeric strength.
 *
 * A numeric `dial` must be a finite number `>= 0` (a negative `C` would pull
 * the score away from the prior instead of toward it). A string `dial` must
 * be an own key of {@link TRUST_DIALS} — looked up with `Object.hasOwn` so a
 * prototype-chain name such as `"constructor"` or `"toString"` is rejected
 * with a clear error instead of resolving to an inherited, non-numeric `.C`.
 *
 * @throws RangeError if `dial` is a negative/non-finite number, or a string
 *   that is not one of `"as_is" | "balanced" | "strict"`.
 */
export function resolveDial(dial: TrustDialPreset | number): number {
  if (typeof dial === "number") return checkNumber(dial, "dial", { min: 0 });
  if (!hasOwn(TRUST_DIALS, dial)) {
    throw new RangeError(
      `dial must be one of ${Object.keys(TRUST_DIALS).join(", ")}, or a non-negative number (got ${show(dial)})`,
    );
  }
  return TRUST_DIALS[dial].C;
}

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

/**
 * How much credible evidence backs a score. Three bands: enough to stand on
 * its own (`high`), enough to lean on but keep shrinking (`moderate`), or not
 * enough to trust much beyond the baseline (`thin`).
 */
export type ConfidenceLevel = "high" | "moderate" | "thin";

export interface ConfidenceThresholds {
  /** Effective sample size at/above which confidence is "high". */
  high: number;
  /** Effective sample size at/above which confidence is "moderate". */
  moderate: number;
}

export interface Confidence {
  level: ConfidenceLevel;
  /** The effective (credibility-weighted) sample size the label was derived from. */
  effectiveSampleSize: number;
}

/** Derive a confidence label from an effective sample size and its thresholds. */
export function confidenceFromSampleSize(
  effectiveSampleSize: number,
  thresholds: ConfidenceThresholds,
): Confidence {
  const level: ConfidenceLevel =
    effectiveSampleSize >= thresholds.high
      ? "high"
      : effectiveSampleSize >= thresholds.moderate
        ? "moderate"
        : "thin";
  return { level, effectiveSampleSize };
}
