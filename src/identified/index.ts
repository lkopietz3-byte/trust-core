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
  clamp,
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
import {
  assertFinite,
  checkClock,
  checkNumber,
  checkPlainRecord,
  checkRecencyCurve,
  checkRecord,
  checkString,
  checkThresholds,
  checkTimestamp,
  deepFreeze,
  exactSum,
  hasOwn,
  mergeSection,
  rejectUnknownKeys,
  show,
  snapshotArray,
  snapshotWeightMap,
} from "../shared/internal.js";

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
export const EXAMPLE_IDENTIFIED_CONFIG: IdentifiedConfig = deepFreeze({
  tierWeights: { new: 0.4, standard: 0.7, verified: 1.0, expert: 1.3 },
  sourceWeights: { imported: 0.5, referred: 0.8, direct: 1.0 },
  proofWeights: { none: 0.5, self_attested: 0.75, verified: 1.0, documented: 1.2 },
  reputation: { floor: 0.6, ceil: 1.4, neutral: 1.0 },
  recency: { halfLifeDays: 540, missingDateAgeDays: 720 },
  confidence: { high: 8, moderate: 3 },
});

const IDENTIFIED_CONFIG_KEYS = [
  "tierWeights",
  "sourceWeights",
  "proofWeights",
  "reputation",
  "recency",
  "confidence",
] as const;
const REPUTATION_CURVE_KEYS = ["floor", "ceil", "neutral"] as const;

function checkReputationCurve(curve: unknown): ReputationCurve {
  const record = checkPlainRecord(curve, "reputation");
  rejectUnknownKeys(record, REPUTATION_CURVE_KEYS, "reputation");
  return {
    floor: checkNumber(record.floor, "reputation.floor", { min: 0 }),
    ceil: checkNumber(record.ceil, "reputation.ceil", { min: 0 }),
    neutral: checkNumber(record.neutral, "reputation.neutral", { min: 0 }),
  };
}

/** Validate every section once, copy the validated values, and freeze the result. */
function buildConfig(parts: Record<(typeof IDENTIFIED_CONFIG_KEYS)[number], unknown>): IdentifiedConfig {
  return deepFreeze<IdentifiedConfig>({
    tierWeights: snapshotWeightMap(parts.tierWeights, "tierWeights"),
    sourceWeights: snapshotWeightMap(parts.sourceWeights, "sourceWeights"),
    proofWeights: snapshotWeightMap(parts.proofWeights, "proofWeights"),
    reputation: checkReputationCurve(parts.reputation),
    recency: checkRecencyCurve(parts.recency, "recency"),
    confidence: checkThresholds(parts.confidence, "confidence"),
  });
}

/**
 * Shallow-merge a partial override over {@link EXAMPLE_IDENTIFIED_CONFIG} and
 * validate the result: every weight map value is a finite number `>= 0`, the
 * recency and confidence sub-objects have no unknown keys and satisfy their
 * own numeric bounds (`moderate <= high`), and the reputation curve's
 * multipliers are finite and non-negative. The returned config is deep-frozen
 * so it cannot be mutated after the fact.
 *
 * Only `undefined` means "use the defaults": `resolveIdentifiedConfig()` and
 * `resolveIdentifiedConfig(undefined)` return {@link EXAMPLE_IDENTIFIED_CONFIG},
 * and a section left `undefined` keeps its defaults. Any other supplied value
 * (`null`, `false`, `0`, `""`, `NaN`, an array, a `Date`, a `Map`, a class
 * instance) is rejected, and each supplied section is checked BEFORE it is
 * merged. Plain objects and null-prototype objects are accepted as records.
 * Every property of `overrides` is read once.
 *
 * @throws TypeError if `overrides` (or a section of it) is not a plain
 *   object, or has a key outside the known shape.
 * @throws RangeError if a weight, curve, or threshold value is `NaN`,
 *   infinite (where not allowed), negative, or otherwise out of range.
 */
export function resolveIdentifiedConfig(overrides?: Partial<IdentifiedConfig>): IdentifiedConfig {
  if (overrides === undefined) return EXAMPLE_IDENTIFIED_CONFIG;
  const record = checkPlainRecord(overrides, "overrides");
  rejectUnknownKeys(record, IDENTIFIED_CONFIG_KEYS, "overrides");
  const { tierWeights, sourceWeights, proofWeights, reputation, recency, confidence } = record;
  const example = EXAMPLE_IDENTIFIED_CONFIG;
  return buildConfig({
    tierWeights: mergeSection(example.tierWeights, tierWeights, "tierWeights"),
    sourceWeights: mergeSection(example.sourceWeights, sourceWeights, "sourceWeights"),
    proofWeights: mergeSection(example.proofWeights, proofWeights, "proofWeights"),
    reputation: mergeSection(example.reputation, reputation, "reputation"),
    recency: mergeSection(example.recency, recency, "recency"),
    confidence: mergeSection(example.confidence, confidence, "confidence"),
  });
}

/**
 * The config a scoring function will actually use: the caller's config,
 * validated in full and copied once, so the numbers checked are the numbers
 * used even if the caller's object has getters. (A config from
 * {@link resolveIdentifiedConfig} passes this check by construction.)
 */
function readConfig(input: unknown): IdentifiedConfig {
  const record = checkPlainRecord(input, "config");
  rejectUnknownKeys(record, IDENTIFIED_CONFIG_KEYS, "config");
  const { tierWeights, sourceWeights, proofWeights, reputation, recency, confidence } = record;
  return buildConfig({ tierWeights, sourceWeights, proofWeights, reputation, recency, confidence });
}

/**
 * Look up `key` in a weight map, checked with `Object.hasOwn` so a
 * prototype-chain name (`"constructor"`, `"toString"`, `"__proto__"`, ...)
 * is treated as absent rather than silently resolving to an inherited,
 * non-numeric value that would turn the whole signal weight into `NaN`.
 * `key` is always a string here (the signal snapshot checked it), so nothing
 * is coerced into a property key.
 */
function lookupWeight(map: Record<string, number>, key: string, kind: string): number {
  if (!hasOwn(map, key)) {
    throw new RangeError(`trust-core/identified: no weight configured for ${kind} ${show(key)}`);
  }
  return map[key]!;
}

// ---------------------------------------------------------------------------
// Per-signal weight components
// ---------------------------------------------------------------------------

/**
 * Map reputation 0-100 onto a bounded multiplier; unknown reputation is
 * neutral.
 *
 * @throws RangeError if `reputation` is not `null` and outside `[0, 100]`
 *   (including `NaN`, which would otherwise silently produce a `NaN` factor).
 */
export function reputationFactor(reputation: number | null, curve: ReputationCurve): number {
  if (reputation === null) return curve.neutral;
  checkNumber(reputation, "reputation", { min: 0, max: 100 });
  return curve.floor + (curve.ceil - curve.floor) * clamp01(reputation / 100);
}

/**
 * Age in days of a signal's `occurredAt`, falling back to a configured age
 * when unknown.
 *
 * @throws TypeError if `occurredAt` (when not `null`) or `asOf` is not a
 *   valid ISO 8601 timestamp (an invalid one would otherwise silently
 *   produce a `NaN` age via `Date.parse`).
 */
export function signalAgeDays(occurredAt: string | null, asOf: string, recency: RecencyCurve): number {
  checkTimestamp(asOf, "asOf");
  if (occurredAt === null) return recency.missingDateAgeDays;
  checkTimestamp(occurredAt, "occurredAt");
  return Math.max(0, daysBetween(occurredAt, asOf));
}

/**
 * Read a signal's fields ONCE, validate that snapshot, and return it. Every
 * later step uses the snapshot, so a getter or proxy cannot pass validation
 * with one value and be scored with another.
 */
function snapshotSignal(raw: unknown, label: string): IdentifiedSignal {
  const { id, tier, source, proof, reputation, occurredAt, value } = checkRecord(raw, label);
  const snapshot: IdentifiedSignal = {
    id: checkString(id, `${label}.id`),
    tier: checkString(tier, `${label}.tier`),
    source: checkString(source, `${label}.source`),
    proof: checkString(proof, `${label}.proof`),
    reputation: reputation === null ? null : checkNumber(reputation, `${label}.reputation`, { min: 0, max: 100 }),
    occurredAt: null,
    value: 0,
  };
  if (occurredAt !== null) {
    checkTimestamp(occurredAt, `${label}.occurredAt`);
    snapshot.occurredAt = occurredAt as string;
  }
  snapshot.value = checkNumber(value, `${label}.value`, { min: 0, max: 100 });
  return snapshot;
}

/** Weight and age of one already-validated signal snapshot. */
function evaluateSignal(
  signal: IdentifiedSignal,
  config: IdentifiedConfig,
  asOf: string,
): { weight: Weight; ageDays: number | null } {
  const tier = lookupWeight(config.tierWeights, signal.tier, "tier");
  const source = lookupWeight(config.sourceWeights, signal.source, "source");
  const proof = lookupWeight(config.proofWeights, signal.proof, "proof");
  const reputation = reputationFactor(signal.reputation, config.reputation);
  const age = signalAgeDays(signal.occurredAt, asOf, config.recency);
  const recency = recencyDecay(age, config.recency.halfLifeDays);
  return {
    weight: assertFinite(tier * source * proof * reputation * recency, `weight of signal ${show(signal.id)}`),
    ageDays: signal.occurredAt === null ? null : age,
  };
}

/**
 * The intrinsic weight of one signal: tier x source x proof x reputation x
 * recency. Validates the signal's fields first, so a malformed signal (an
 * out-of-range `value`/`reputation`, a non-ISO `occurredAt`, a non-string
 * tier/source/proof) throws a clear `TypeError`/`RangeError` here instead of
 * silently producing a `NaN` weight several calls later. Each field of
 * `signal` is read once, and `config` is validated ({@link scoreEntity}).
 *
 * @throws TypeError if `asOf`/`occurredAt` is not a valid ISO 8601 timestamp,
 *   `tier`/`source`/`proof`/`id` is not a string, or `signal`/`config` is not
 *   an object of the right shape.
 * @throws RangeError if `value` or `reputation` is outside `[0, 100]`, if
 *   `tier`/`source`/`proof` has no configured weight, or if the product of
 *   the factors overflows or is not finite.
 */
export function signalWeight(signal: IdentifiedSignal, config: IdentifiedConfig, asOf: string): Weight {
  checkTimestamp(asOf, "asOf");
  const snapshot = snapshotSignal(signal, "signal");
  return evaluateSignal(snapshot, readConfig(config), asOf).weight;
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

/** UTF-16 code unit order: the same on every machine and locale. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Heaviest first; ties by id, tier, source, proof, then age (unknown age
 * last). The order depends only on the contributions themselves, never on the
 * order the signals were supplied in.
 */
function compareContributions(a: SignalContribution, b: SignalContribution): number {
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

export interface EntityScore {
  /** Final 0-100 score, shrunk toward `prior` by the dial. */
  score: number;
  /** Unshrunk credibility-weighted mean, or `null` when there is no evidence at all. */
  raw: number | null;
  prior: number;
  /** Effective sample size — sum of signal weights, not a raw count. */
  nEff: number;
  /** How many signals were submitted (including any that carried zero weight). */
  signalCount: number;
  /** How many signals carried a positive weight and so contributed to `score`, `raw`, `nEff` and `confidence`. */
  eligibleSignalCount: number;
  /** `level` is `"insufficient"` (with a `reason`) when no signal carried any weight. */
  confidence: Confidence;
  /** Heaviest-weighted signals first; equal weights are ordered by id, then tier, source, proof and age. Zero-weight signals are listed, with weight 0, so the audit trail shows they were received. */
  contributions: SignalContribution[];
}

export interface ScoreEntityOptions {
  /**
   * "Now" recency decay is computed against: a strict ISO 8601 string, or a
   * `Date`. Pass a fixed value for determinism. Named `now` (not `asOf`) to
   * match `anonymous.assessAuthenticity` and sibling kits
   * (claims-registry-kit, freshness-kit).
   */
  now: string | Date;
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
 *
 * Signal weights and weighted values are summed with an order-independent,
 * correctly-rounded algorithm (`exactSum`), so `score`/`raw`/`nEff` do not
 * depend on the order `signals` is given in and do not drift as the count
 * grows. `score` and `raw` are clamped to `[0, 100]` as a final safety net
 * against floating-point overshoot at the boundary.
 *
 * @throws TypeError if `options` is missing/not an object, `now` is neither
 *   a valid ISO 8601 timestamp nor a `Date`, or `signals` is not an array.
 * @throws RangeError if `now` is an Invalid `Date`, `prior` is outside
 *   `[0, 100]`, `dial` is a negative number or an unrecognized preset name,
 *   or any signal fails validation (see {@link signalWeight}).
 */
export function scoreEntity(
  signals: readonly IdentifiedSignal[],
  config: IdentifiedConfig,
  options: ScoreEntityOptions,
): EntityScore {
  const list = snapshotArray(signals, "signals");
  const { now: rawNow, prior: rawPrior, dial: rawDial } = checkRecord(options, "options");
  const now = checkClock(rawNow, "now");
  const prior = checkNumber(rawPrior, "prior", { min: 0, max: 100 });
  const C = resolveDial((rawDial === undefined ? "balanced" : rawDial) as TrustDialPreset | number);
  const resolved = readConfig(config);
  const snapshots = list.map((raw, index) => snapshotSignal(raw, `signals[${index}]`));

  const weights: number[] = [];
  const weightedValues: number[] = [];
  const contributions: SignalContribution[] = [];

  for (const signal of snapshots) {
    const { weight, ageDays } = evaluateSignal(signal, resolved, now);
    weights.push(weight);
    weightedValues.push(assertFinite(weight * signal.value, `weighted value of signal ${show(signal.id)}`));
    contributions.push({
      id: signal.id,
      tier: signal.tier,
      source: signal.source,
      proof: signal.proof,
      weight,
      ageDays,
    });
  }

  contributions.sort(compareContributions);

  const nEff = exactSum(weights);
  const weightedSum = exactSum(weightedValues);
  const raw = nEff > 0 ? clamp(weightedSum / nEff, 0, 100) : null;
  const score = clamp(shrinkTowardPrior(weightedSum, nEff, prior, C), 0, 100);

  const confidence = confidenceFromSampleSize(nEff, resolved.confidence);
  if (confidence.level === "insufficient") confidence.reason = "no signal has a positive weight, so the score is the prior";

  return {
    score,
    raw,
    prior,
    nEff,
    signalCount: snapshots.length,
    eligibleSignalCount: weights.filter((weight) => weight > 0).length,
    confidence,
    contributions,
  };
}

/**
 * Combine several already-scored dimensions (e.g. quality, reliability,
 * communication) into one composite using caller-supplied weights.
 * Dimensions with a missing or non-positive weight are excluded. Returns 0
 * if no dimension has a positive weight. `weights` is looked up with
 * `Object.hasOwn` so a prototype-chain dimension name is treated as missing
 * (weight 0) rather than resolving to an inherited, non-numeric value.
 *
 * @throws TypeError if `scores` or `weights` is not a plain object.
 * @throws RangeError if a weight present in `weights` is `NaN` or infinite.
 */
export function composeDimensions(
  scores: Record<string, EntityScore>,
  weights: Record<string, number>,
): number {
  checkPlainRecord(scores, "scores");
  checkPlainRecord(weights, "weights");
  const numerators: number[] = [];
  const denominators: number[] = [];
  for (const [key, entry] of Object.entries(scores)) {
    const w = hasOwn(weights, key) ? weights[key]! : 0;
    checkNumber(w, `weights[${show(key)}]`, {});
    const dimension = checkRecord(entry, `scores[${show(key)}]`);
    const dimensionScore = checkNumber(dimension.score, `scores[${show(key)}].score`, { min: 0, max: 100 });
    if (w <= 0) continue;
    numerators.push(assertFinite(w * dimensionScore, `weighted score of dimension ${show(key)}`));
    denominators.push(w);
  }
  const den = exactSum(denominators);
  return den > 0 ? clamp(exactSum(numerators) / den, 0, 100) : 0;
}
