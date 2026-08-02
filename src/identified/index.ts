/**
 * trust-core/identified — score entities from KNOWN contributors.
 *
 * Use this when every signal has an identity and a history behind it: a
 * reviewer account, a rater, an inspector, a verified buyer. The pattern:
 *
 *   1. Each signal carries a 0-100 `value` for whatever is being scored
 *      (a dimension of quality, a rating, a pass/fail-turned-score...).
 *   2. Per-signal weight = tierWeight x sourceFactor x proofFactor x
 *      reputationFactor x recencyDecay.
 *   3. nEff = sum of weights — a credibility-weighted "sample size", not a
 *      raw count. Ten low-tier, unproven, stale signals can carry less
 *      weight than one verified, well-proven, fresh one.
 *   4. The weighted mean shrinks toward a caller-supplied `prior` (a
 *      domain/category baseline) by a dial's strength `C` — thin evidence
 *      stays close to the prior, deep evidence overrides it.
 *   5. Confidence is a label derived from nEff, not from the raw count.
 *
 * Every weight is configuration (`IdentifiedConfig`), supplied by the
 * caller for their own domain — contractors, stylists, products, vendors,
 * whatever. Nothing domain-specific is hardcoded in this module.
 */

import {
  clamp01,
  confidenceFromSampleSize,
  daysBetween,
  recencyDecay,
  resolveDial,
  shrinkTowardPrior,
  type Confidence,
  type ConfidenceThresholds,
  type TrustDialPreset,
  type Weight,
} from "../shared/types.js";

export { TRUST_DIALS, type TrustDial, type TrustDialPreset } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Signals & configuration
// ---------------------------------------------------------------------------

/**
 * One scored contribution from a known, identified contributor. `tier`,
 * `source`, and `proof` are free-form string keys — they mean whatever the
 * caller's `IdentifiedConfig` says they mean (e.g. tier: "new" | "verified"
 * | "expert"; proof: "none" | "receipt" | "site_visit").
 */
export interface IdentifiedSignal {
  id: string;
  /** Key into `config.tierWeights` — the contributor's standing/tier. */
  tier: string;
  /** Key into `config.sourceWeights` — how the signal reached the system. */
  source: string;
  /** Key into `config.proofWeights` — strength of evidence the event happened. */
  proof: string;
  /** Contributor reputation, 0-100, or `null` if unknown (treated as neutral). */
  reputation: number | null;
  /** ISO date the underlying event happened, or `null` if unknown (uses a configured fallback age). */
  occurredAt: string | null;
  /** The 0-100 score this signal reports. */
  value: number;
}

export interface ReputationCurve {
  /** Multiplier applied at reputation 0. */
  floor: number;
  /** Multiplier applied at reputation 100. */
  ceil: number;
  /** Multiplier applied when reputation is unknown (`null`). */
  neutral: number;
}

export interface RecencyCurve {
  /** Days for the recency multiplier to halve. */
  halfLifeDays: number;
  /** Age (in days) assumed for signals with no `occurredAt`. */
  missingDateAgeDays: number;
}

export interface IdentifiedConfig {
  tierWeights: Record<string, number>;
  sourceWeights: Record<string, number>;
  proofWeights: Record<string, number>;
  reputation: ReputationCurve;
  recency: RecencyCurve;
  confidence: ConfidenceThresholds;
}

/**
 * An illustrative starting configuration — every number here is meant to be
 * overridden. Treat it as a worked example (tiers: new/standard/verified/
 * expert), not a domain default. Real callers should supply their own tier,
 * source, and proof vocabularies via {@link resolveIdentifiedConfig}.
 */
export const EXAMPLE_IDENTIFIED_CONFIG: IdentifiedConfig = {
  tierWeights: { new: 0.4, standard: 0.7, verified: 1.0, expert: 1.3 },
  sourceWeights: { imported: 0.5, referred: 0.8, direct: 1.0 },
  proofWeights: { none: 0.5, self_attested: 0.75, verified: 1.0, documented: 1.2 },
  reputation: { floor: 0.6, ceil: 1.4, neutral: 1.0 },
  recency: { halfLifeDays: 540, missingDateAgeDays: 720 },
  confidence: { high: 8, moderate: 3 },
};

/** Shallow-merge a partial override over {@link EXAMPLE_IDENTIFIED_CONFIG}. */
export function resolveIdentifiedConfig(overrides?: Partial<IdentifiedConfig>): IdentifiedConfig {
  if (!overrides) return EXAMPLE_IDENTIFIED_CONFIG;
  return {
    tierWeights: { ...EXAMPLE_IDENTIFIED_CONFIG.tierWeights, ...overrides.tierWeights },
    sourceWeights: { ...EXAMPLE_IDENTIFIED_CONFIG.sourceWeights, ...overrides.sourceWeights },
    proofWeights: { ...EXAMPLE_IDENTIFIED_CONFIG.proofWeights, ...overrides.proofWeights },
    reputation: { ...EXAMPLE_IDENTIFIED_CONFIG.reputation, ...overrides.reputation },
    recency: { ...EXAMPLE_IDENTIFIED_CONFIG.recency, ...overrides.recency },
    confidence: { ...EXAMPLE_IDENTIFIED_CONFIG.confidence, ...overrides.confidence },
  };
}

function lookupWeight(map: Record<string, number>, key: string, kind: string): number {
  const w = map[key];
  if (w === undefined) {
    throw new Error(`trust-core/identified: no weight configured for ${kind} "${key}"`);
  }
  return w;
}

// ---------------------------------------------------------------------------
// Per-signal weight components
// ---------------------------------------------------------------------------

/** Map reputation 0-100 onto a bounded multiplier; unknown reputation is neutral. */
export function reputationFactor(reputation: number | null, curve: ReputationCurve): number {
  if (reputation == null) return curve.neutral;
  return curve.floor + (curve.ceil - curve.floor) * clamp01(reputation / 100);
}

/** Age in days of a signal's `occurredAt`, falling back to a configured age when unknown. */
export function signalAgeDays(occurredAt: string | null, asOf: string, recency: RecencyCurve): number {
  if (!occurredAt) return recency.missingDateAgeDays;
  return Math.max(0, daysBetween(occurredAt, asOf));
}

/** The intrinsic weight of one signal: tier x source x proof x reputation x recency. */
export function signalWeight(signal: IdentifiedSignal, config: IdentifiedConfig, asOf: string): Weight {
  const tier = lookupWeight(config.tierWeights, signal.tier, "tier");
  const source = lookupWeight(config.sourceWeights, signal.source, "source");
  const proof = lookupWeight(config.proofWeights, signal.proof, "proof");
  const reputation = reputationFactor(signal.reputation, config.reputation);
  const age = signalAgeDays(signal.occurredAt, asOf, config.recency);
  const recency = recencyDecay(age, config.recency.halfLifeDays);
  return tier * source * proof * reputation * recency;
}

// ---------------------------------------------------------------------------
// Entity scoring
// ---------------------------------------------------------------------------

export interface SignalContribution {
  id: string;
  tier: string;
  source: string;
  proof: string;
  weight: Weight;
  ageDays: number | null;
}

export interface EntityScore {
  /** Final 0-100 score, shrunk toward `prior` by the dial. */
  score: number;
  /** Unshrunk credibility-weighted mean, or `null` when there is no evidence at all. */
  raw: number | null;
  prior: number;
  /** Effective sample size — sum of signal weights, not a raw count. */
  nEff: number;
  signalCount: number;
  confidence: Confidence;
  /** Heaviest-weighted signals first. */
  contributions: SignalContribution[];
}

export interface ScoreEntityOptions {
  /** ISO "now" recency decay is computed against. Pass a fixed value for determinism. */
  asOf: string;
  /** The domain/category baseline the score shrinks toward when evidence is thin. */
  prior: number;
  /** Shrinkage strength: a named dial preset, or a custom `C`. Defaults to "balanced". */
  dial?: TrustDialPreset | number;
}

/**
 * Score one entity — or one dimension of one entity — from its identified
 * signals. Call it once per dimension (quality, reliability, communication,
 * ...) and combine the results with {@link composeDimensions} if a domain
 * needs more than one axis.
 */
export function scoreEntity(
  signals: readonly IdentifiedSignal[],
  config: IdentifiedConfig,
  options: ScoreEntityOptions,
): EntityScore {
  const { asOf, prior } = options;
  const C = resolveDial(options.dial ?? "balanced");

  let weightedSum = 0;
  let nEff = 0;
  const contributions: SignalContribution[] = [];

  for (const signal of signals) {
    const weight = signalWeight(signal, config, asOf);
    weightedSum += weight * signal.value;
    nEff += weight;
    contributions.push({
      id: signal.id,
      tier: signal.tier,
      source: signal.source,
      proof: signal.proof,
      weight,
      ageDays: signal.occurredAt ? Math.max(0, daysBetween(signal.occurredAt, asOf)) : null,
    });
  }

  contributions.sort((a, b) => b.weight - a.weight);

  const raw = nEff > 0 ? weightedSum / nEff : null;
  const score = shrinkTowardPrior(weightedSum, nEff, prior, C);

  return {
    score,
    raw,
    prior,
    nEff,
    signalCount: signals.length,
    confidence: confidenceFromSampleSize(nEff, config.confidence),
    contributions,
  };
}

/**
 * Combine several already-scored dimensions (e.g. quality, reliability,
 * communication) into one composite using caller-supplied weights.
 * Dimensions with a missing or non-positive weight are excluded. Returns 0
 * if no dimension has a positive weight.
 */
export function composeDimensions(
  scores: Record<string, EntityScore>,
  weights: Record<string, number>,
): number {
  let num = 0;
  let den = 0;
  for (const [key, score] of Object.entries(scores)) {
    const w = weights[key] ?? 0;
    if (w <= 0) continue;
    num += w * score.score;
    den += w;
  }
  return den > 0 ? num / den : 0;
}
