/**
 * trust-core/anonymous — gauge how organic a corpus of UNATTRIBUTED signals looks.
 *
 * Use this when you don't know who's behind a signal: crawled mentions,
 * imported reviews with no verifiable identity, aggregator feeds. There is no
 * reputation to weight and no prior to shrink toward — instead the question
 * is "does the pattern of this corpus look varied and recent, or does it show
 * a pattern the heuristics discount?" The answer is a heuristic score, not a
 * finding about any observation, and it does not verify that sources are
 * independent: `source` is a caller-supplied type label.
 *
 * Only ELIGIBLE observations count: an observation whose effective weight
 * (source credibility x confidence x recency decay) is above 0. With none, the
 * result says so explicitly (`confidence.level === "insufficient"`).
 *
 * Source labels are compared after trimming and case-folding, so `"forum"`,
 * `"Forum"` and `" forum "` are one source type. A source type counts in full
 * once its own effective weight reaches half of one fresh, fully confident
 * observation from the most credible configured source type, and in
 * proportion below that, so a near-weightless observation cannot add a source
 * type. Because a source type's count depends only on its own weight,
 * evidence added anywhere never makes another source type count for less.
 *
 * **When the score can drop.** Adding an observation never lowers
 * `trustScore` when its sentiment is at or above the corpus's weighted mean
 * sentiment and it is at least as fresh as the corpus on average (for
 * example, published at `now`), from any source type, with one exception: it
 * can raise the uniformity discount (identical praise is more uniform, and the
 * uniformity check starts to apply once there are `minSignalsForUniformCheck`
 * effective observations). An older observation lowers the average recency,
 * and a less positive one lowers consensus.
 *
 * The pattern:
 *   - `volume`    — log-scaled effective count of source types (saturating,
 *                   so the 50th type barely matters more than the 12th).
 *   - `diversity` — effective count of source types against a reference of
 *                   six. It depends on how broad the evidence is, not on how
 *                   few observations there are, so one observation never gets
 *                   full diversity and more observations never lower it.
 *   - `consensus` — recency- and confidence-weighted mean sentiment, with
 *                   each source type weighted by a caller-supplied
 *                   "localness"/credibility factor.
 *   - `recency`   — how fresh the evidence is, on average.
 *   - `astroturfPenalty` — subtracted from the (capped) positive composite
 *                   when the evidence shows a discounted pattern: concentrated
 *                   in too few source types, or uniform (near-maximal
 *                   sentiment with near-zero variance). Both discounts ramp
 *                   in smoothly instead of switching on at a cliff.
 *
 * Every weight and threshold is configuration (`AnonymousConfig`), supplied
 * by the caller for their own source taxonomy.
 */

import {
  clamp01,
  confidenceFromSampleSize,
  daysBetween,
  recencyDecay,
  type Confidence,
  type ConfidenceThresholds,
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
  mergeSection,
  rejectUnknownKeys,
  show,
  snapshotArray,
  snapshotWeightMap,
  usableAgeDays,
} from "../shared/internal.js";

// ---------------------------------------------------------------------------
// Signals & configuration
// ---------------------------------------------------------------------------

/**
 * One unattributed sentiment observation about an entity — a scraped review,
 * a forum post's derived sentiment, an aggregator's summary line. `source` is
 * a free-form string key meaning whatever the caller's `AnonymousConfig`
 * says it means (e.g. "forum" | "marketplace" | "social" | "blog").
 */
export interface AnonymousSignal {
  id: string;
  /** Key into `config.sourceWeights` — the source type. */
  source: string;
  /** Net sentiment, `[-1, 1]`. */
  sentiment: number;
  /** Extraction/observation confidence, `[0, 1]`. */
  confidence: number;
  /** ISO date the underlying material was published, or `null`/`undefined` if unknown. */
  publishedAt?: string | null;
}

/** How an observation's age lowers its weight: the weight halves every `halfLifeDays`. */
export interface RecencyCurve {
  /** Days for the recency weight to halve. `Infinity` means never; `0` means full weight only at age 0. */
  halfLifeDays: number;
  /** Age (in days) assumed for signals with no `publishedAt`. */
  missingDateAgeDays: number;
}

/** Weighting of the four positive components. They are used as given and need not sum to 1, but 1 keeps `trustScore` intuitive as a 0-100 scale. The composite is capped at 1 before the astroturf discount, so weights above 1 saturate rather than absorb it. */
export interface AuthenticityWeights {
  consensus: number;
  diversity: number;
  volume: number;
  recency: number;
}

/**
 * Thresholds for the two patterns the heuristics discount (too few source
 * types, near-uniform near-maximal sentiment). Crossing one lowers the score;
 * it is not a finding that any observation is fabricated. The name comes from
 * the library's original purpose and is kept for API stability.
 */
export interface AstroturfRules {
  /**
   * Effective source-type count at/under which the full concentration penalty
   * applies. Between this count and one more, the penalty ramps down linearly
   * to 0, so a second source type carrying a sliver of the full-count weight
   * earns only a sliver of relief.
   */
  concentrationSourceCeiling: number;
  /** Full concentration penalty (at/under the ceiling). */
  concentrationPenalty: number;
  /** Weighted mean sentiment above this threshold is a candidate for the uniformity penalty. */
  uniformMeanThreshold: number;
  /** Weighted sentiment variance below this threshold is a candidate for the uniformity penalty. */
  uniformVarianceThreshold: number;
  /**
   * Largest uniformity penalty, reached with zero variance and a weighted mean
   * at least 0.05 past `uniformMeanThreshold`. It ramps in linearly over that
   * 0.05 of mean and with the square of how far the variance is below its
   * threshold, so it starts at 0 at the thresholds (no cliff) and identical
   * praise from 0.9 up (with the example threshold) gets all of it.
   */
  uniformPenalty: number;
  /** Minimum effective observation count before the uniformity check applies (avoids false positives on tiny n): an observation at or above the full-count weight counts as one, a lighter one in proportion. The concentration check applies at any count. */
  minSignalsForUniformCheck: number;
}

/**
 * Everything `assessAuthenticity` needs. Build one with
 * {@link resolveAnonymousConfig}; a hand-built object is accepted too and is
 * validated in full on every call.
 */
export interface AnonymousConfig {
  /** "Localness"/credibility weight per source type, each a finite number `>= 0` (about `[0, 1]`). A source type that is unlisted, or listed with 0, makes its observations ineligible: they count for nothing. */
  sourceWeights: Record<string, number>;
  weights: AuthenticityWeights;
  /** How much the astroturf penalty (`[0, 1]`) is subtracted from the positive composite. */
  astroturfWeight: number;
  /** Age-decay curve. */
  recency: RecencyCurve;
  /** Source count at which the log-scaled volume term saturates to full credit. */
  volumeSaturation: number;
  /** Thresholds for the two discounted patterns. */
  astroturf: AstroturfRules;
  /** Cut-offs, in distinct eligible source types, for `high` and `moderate` confidence. */
  confidence: ConfidenceThresholds;
}

/**
 * An illustrative starting configuration — every number here is meant to be
 * overridden. Treat it as a worked example, not a domain default. Tools that
 * use it as a default get the verdicts pinned in `src/verdict-table.test.ts`.
 */
export const EXAMPLE_ANONYMOUS_CONFIG: AnonymousConfig = deepFreeze({
  sourceWeights: { forum: 0.85, community: 0.8, marketplace: 0.5, aggregator: 0.4, blog: 0.6, social: 0.5 },
  weights: { consensus: 0.4, diversity: 0.25, volume: 0.2, recency: 0.15 },
  astroturfWeight: 0.35,
  recency: { halfLifeDays: 540, missingDateAgeDays: 540 },
  volumeSaturation: 12,
  astroturf: {
    concentrationSourceCeiling: 1,
    concentrationPenalty: 0.6,
    uniformMeanThreshold: 0.85,
    uniformVarianceThreshold: 0.02,
    uniformPenalty: 0.4,
    minSignalsForUniformCheck: 3,
  },
  confidence: { high: 6, moderate: 3 },
});

const ANONYMOUS_CONFIG_KEYS = [
  "sourceWeights",
  "weights",
  "astroturfWeight",
  "recency",
  "volumeSaturation",
  "astroturf",
  "confidence",
] as const;
const AUTHENTICITY_WEIGHTS_KEYS = ["consensus", "diversity", "volume", "recency"] as const;
const ASTROTURF_RULES_KEYS = [
  "concentrationSourceCeiling",
  "concentrationPenalty",
  "uniformMeanThreshold",
  "uniformVarianceThreshold",
  "uniformPenalty",
  "minSignalsForUniformCheck",
] as const;

function checkAuthenticityWeights(weights: unknown): AuthenticityWeights {
  const record = checkPlainRecord(weights, "weights");
  rejectUnknownKeys(record, AUTHENTICITY_WEIGHTS_KEYS, "weights");
  return {
    consensus: checkNumber(record.consensus, "weights.consensus", { min: 0 }),
    diversity: checkNumber(record.diversity, "weights.diversity", { min: 0 }),
    volume: checkNumber(record.volume, "weights.volume", { min: 0 }),
    recency: checkNumber(record.recency, "weights.recency", { min: 0 }),
  };
}

function checkAstroturfRules(rules: unknown): AstroturfRules {
  const record = checkPlainRecord(rules, "astroturf");
  rejectUnknownKeys(record, ASTROTURF_RULES_KEYS, "astroturf");
  return {
    concentrationSourceCeiling: checkNumber(record.concentrationSourceCeiling, "astroturf.concentrationSourceCeiling", {
      min: 0,
    }),
    concentrationPenalty: checkNumber(record.concentrationPenalty, "astroturf.concentrationPenalty", { min: 0 }),
    uniformMeanThreshold: checkNumber(record.uniformMeanThreshold, "astroturf.uniformMeanThreshold", {
      min: -1,
      max: 1,
    }),
    uniformVarianceThreshold: checkNumber(record.uniformVarianceThreshold, "astroturf.uniformVarianceThreshold", {
      min: 0,
    }),
    uniformPenalty: checkNumber(record.uniformPenalty, "astroturf.uniformPenalty", { min: 0 }),
    minSignalsForUniformCheck: checkNumber(record.minSignalsForUniformCheck, "astroturf.minSignalsForUniformCheck", {
      min: 0,
    }),
  };
}

/**
 * The form a source label is compared in: trimmed and case-folded, so
 * `"Forum"`, `" forum"` and `"FORUM "` are one source type. Applies to both
 * `config.sourceWeights` keys and each signal's `source`.
 */
function normalizeSourceLabel(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * Validate a `sourceWeights` map and reject two keys that name the same
 * source type after normalization but carry different weights: which weight
 * applies would otherwise depend on key order.
 */
function snapshotSourceWeights(map: unknown): Record<string, number> {
  const weights = snapshotWeightMap(map, "sourceWeights");
  const seen = new Map<string, string>();
  for (const [key, weight] of Object.entries(weights)) {
    const label = normalizeSourceLabel(key);
    const earlier = seen.get(label);
    if (earlier !== undefined && weights[earlier] !== weight) {
      throw new RangeError(
        `sourceWeights keys ${show(earlier)} and ${show(key)} are the same source type after trimming and ` +
          `case-folding, but have different weights (${weights[earlier]} and ${weight})`,
      );
    }
    seen.set(label, key);
  }
  return weights;
}

/**
 * Merge a `sourceWeights` override over the defaults by normalized label: an
 * override key replaces every default key that names the same source type
 * (`{ Forum: 1 }` replaces the default `forum`). Two keys within the caller's
 * own map that collide are still rejected by {@link snapshotSourceWeights}.
 */
function mergeSourceWeights(defaults: Record<string, number>, override: unknown): Record<string, unknown> {
  if (override === undefined) return { ...defaults };
  const record = checkPlainRecord(override, "sourceWeights");
  const overridden = new Set(Object.keys(record).map(normalizeSourceLabel));
  const kept = Object.entries(defaults).filter(([key]) => !overridden.has(normalizeSourceLabel(key)));
  return { ...Object.fromEntries(kept), ...record };
}

/** Validate every section once, copy the validated values, and freeze the result. */
function buildConfig(parts: Record<(typeof ANONYMOUS_CONFIG_KEYS)[number], unknown>): AnonymousConfig {
  return deepFreeze<AnonymousConfig>({
    sourceWeights: snapshotSourceWeights(parts.sourceWeights),
    weights: checkAuthenticityWeights(parts.weights),
    astroturfWeight: checkNumber(parts.astroturfWeight, "astroturfWeight", { min: 0 }),
    recency: checkRecencyCurve(parts.recency, "recency"),
    volumeSaturation: checkNumber(parts.volumeSaturation, "volumeSaturation", { min: 0, minExclusive: true }),
    astroturf: checkAstroturfRules(parts.astroturf),
    confidence: checkThresholds(parts.confidence, "confidence"),
  });
}

/**
 * Shallow-merge a partial override over {@link EXAMPLE_ANONYMOUS_CONFIG} and
 * validate the result: `sourceWeights` values are finite and `>= 0`, the
 * positive-composite `weights` and `astroturf` rules are finite and within
 * their documented ranges, and `recency`/`confidence` have no unknown keys.
 * The returned config is deep-frozen so it cannot be mutated after the fact.
 *
 * Only `undefined` means "use the defaults": `resolveAnonymousConfig()` and
 * `resolveAnonymousConfig(undefined)` return {@link EXAMPLE_ANONYMOUS_CONFIG},
 * and a section or number left `undefined` keeps its default. Any other
 * supplied value (`null`, `false`, `0`, `""`, `NaN`, an array, a `Date`, a
 * `Map`, a class instance, or a string where a number belongs) is rejected,
 * and each supplied section is checked BEFORE it is merged. Plain objects and
 * null-prototype objects are accepted as records. Every property of
 * `overrides` is read once.
 *
 * @throws TypeError if `overrides` (or a section of it) is not a plain
 *   object, a number is not a number, or a key is outside the known shape.
 * @throws RangeError if a weight, curve, or threshold value is `NaN`,
 *   infinite (where not allowed), negative, or otherwise out of range.
 */
export function resolveAnonymousConfig(overrides?: Partial<AnonymousConfig>): AnonymousConfig {
  if (overrides === undefined) return EXAMPLE_ANONYMOUS_CONFIG;
  const record = checkPlainRecord(overrides, "overrides");
  rejectUnknownKeys(record, ANONYMOUS_CONFIG_KEYS, "overrides");
  const { sourceWeights, weights, astroturfWeight, recency, volumeSaturation, astroturf, confidence } = record;
  const example = EXAMPLE_ANONYMOUS_CONFIG;
  return buildConfig({
    sourceWeights: mergeSourceWeights(example.sourceWeights, sourceWeights),
    weights: mergeSection(example.weights, weights, "weights"),
    astroturfWeight: astroturfWeight === undefined ? example.astroturfWeight : astroturfWeight,
    recency: mergeSection(example.recency, recency, "recency"),
    volumeSaturation: volumeSaturation === undefined ? example.volumeSaturation : volumeSaturation,
    astroturf: mergeSection(example.astroturf, astroturf, "astroturf"),
    confidence: mergeSection(example.confidence, confidence, "confidence"),
  });
}

/**
 * The config a scoring function will actually use: the caller's config,
 * validated in full and copied once, so the numbers checked are the numbers
 * used even if the caller's object has getters. (A config from
 * {@link resolveAnonymousConfig} passes this check by construction.)
 */
function readConfig(input: unknown): AnonymousConfig {
  const record = checkPlainRecord(input, "config");
  rejectUnknownKeys(record, ANONYMOUS_CONFIG_KEYS, "config");
  const { sourceWeights, weights, astroturfWeight, recency, volumeSaturation, astroturf, confidence } = record;
  return buildConfig({ sourceWeights, weights, astroturfWeight, recency, volumeSaturation, astroturf, confidence });
}

/**
 * Credibility per normalized source label. A `Map` is used, so a
 * prototype-chain name (`"constructor"`, `"toString"`, ...) is just an
 * unlisted label: it falls back to the documented "unknown source" default of
 * 0 instead of resolving to an inherited, non-numeric value that would corrupt
 * the corpus's consensus and recency accumulators with `NaN`. A legitimately
 * unclassified source type also defaults to 0 — anonymous corpora routinely
 * include source types nobody has classified yet, and a new, unweighted source
 * shouldn't crash the assessment.
 */
function sourceWeightLookup(config: AnonymousConfig): (source: string) => number {
  const byLabel = new Map<string, number>();
  for (const [key, weight] of Object.entries(config.sourceWeights)) byLabel.set(normalizeSourceLabel(key), weight);
  return (source) => byLabel.get(source) ?? 0;
}

/**
 * The full-count weight, as a fraction of the largest configured credibility:
 * a source type counts in full toward the effective source-type count once
 * its own summed effective weight reaches this fraction of one fresh,
 * fully confident observation from the most credible configured source type,
 * and in proportion below that. With the example config that is 0.425, so one
 * fresh forum post (0.77) counts in full and an observation at confidence
 * 0.001 counts for 0.002 of a source type.
 *
 * It depends only on that source type's own weight, never on its share of the
 * total, so evidence added to another source type can never make it count
 * for less. It is relative to the configured credibilities, so scaling every
 * `sourceWeights` value by the same factor changes nothing.
 */
const FULL_COUNT_FRACTION = 0.5;

/** A source type at or above this fraction of the full-count weight is counted in `sourceCount`. */
const COUNTED_SOURCE_FRACTION = 0.5;

/**
 * Snap a sum that floating-point roundoff left a hair off a whole number
 * (`2.9999999999999996`) onto it, so a threshold or count is not decided by
 * the last bit. Monotone: it never reorders two values.
 */
function snapNearInteger(value: number): number {
  const nearest = Math.round(value);
  return Math.abs(value - nearest) <= 1e-9 * Math.max(1, Math.abs(value)) ? nearest : value;
}

/** The effective source-type count at which `diversity` reaches 1. */
const DIVERSITY_REFERENCE_SOURCES = 6;

/**
 * How far past `uniformMeanThreshold` the weighted mean must be for the full
 * mean factor of the uniformity discount: 0.05 (or the distance to 1, if
 * smaller). With the example threshold of 0.85, identical praise at 0.9 or
 * above gets the full mean factor.
 */
const UNIFORM_MEAN_RAMP = 0.05;

// ---------------------------------------------------------------------------
// Authenticity assessment
// ---------------------------------------------------------------------------

/** The parts of the score, each in `[0, 1]`, so a caller can see why a score is what it is. */
export interface AuthenticityComponents {
  consensus: number;
  diversity: number;
  volume: number;
  recency: number;
  /** `[0, 1]` — higher means a stronger pattern the heuristics discount. */
  astroturfPenalty: number;
}

/** Which of the two discounted patterns were seen. A flag is true exactly when its discount is above 0. */
export interface AstroturfFlags {
  /** True when the eligible evidence comes from too few source types (effective count below `concentrationSourceCeiling + 1`). */
  lowSourceCount: boolean;
  /** True when weighted sentiment is near-maximal with near-zero variance. A pattern in the numbers, not a finding about any observation. */
  uniformSentiment: boolean;
}

/** The result of {@link assessAuthenticity}. */
export interface AuthenticityAssessment {
  /**
   * 0-100, or `null` when `confidence.level` is `"insufficient"`: with no
   * usable evidence there is no score. A number here is never a stand-in for
   * missing data. `null` is not a low score, so handle it before sorting or
   * comparing: JavaScript's `<` and `-` treat `null` as `0`, which would rank
   * an entity nobody has said anything about as the least trustworthy.
   */
  trustScore: number | null;
  components: AuthenticityComponents;
  /**
   * Counted source types among ELIGIBLE observations: labels are trimmed and
   * case-folded, and a source type is counted once its own effective weight
   * reaches half of the full-count weight (a quarter of one fresh, fully
   * confident observation from the most credible configured source type). At
   * least 1 whenever any observation is eligible. The source strings are
   * caller-supplied labels; nothing verifies they are independent publishers.
   */
  sourceCount: number;
  /** How many observations were submitted (including ineligible ones). */
  signalCount: number;
  /** How many observations were eligible: an effective weight above 0 (credibility x confidence x recency decay). Only these contribute to any other field. */
  eligibleSignalCount: number;
  flags: AstroturfFlags;
  /** `effectiveSampleSize` is `sourceCount`. `level` is `"insufficient"` (with a `reason`) when no observation is eligible. */
  confidence: Confidence;
  /** A plain-language summary of patterns and uncertainty. It states no conclusion about whether any observation is genuine, and does not say the sources are independent. */
  explanation: string;
}

/** Options for {@link assessAuthenticity}. */
export interface AssessAuthenticityOptions {
  /**
   * "Now" recency decay is computed against: a strict ISO 8601 string, or a
   * `Date`. Pass a fixed value for determinism.
   */
  now: string | Date;
}

/**
 * Read a signal's fields ONCE, validate that snapshot, and return it. Every
 * later step uses the snapshot, so a getter or proxy cannot pass validation
 * with one value and be scored with another. `id` is not read: nothing in the
 * assessment depends on it.
 */
function snapshotSignal(raw: unknown, label: string): Observation {
  const { source, sentiment, confidence, publishedAt } = checkRecord(raw, label);
  const snapshot: Observation = {
    source: checkString(source, `${label}.source`),
    sentiment: checkNumber(sentiment, `${label}.sentiment`, { min: -1, max: 1 }),
    confidence: checkNumber(confidence, `${label}.confidence`, { min: 0, max: 1 }),
    publishedAt: null,
  };
  if (publishedAt !== null && publishedAt !== undefined) {
    checkTimestamp(publishedAt, `${label}.publishedAt`);
    snapshot.publishedAt = publishedAt as string;
  }
  return snapshot;
}

/** The validated fields of one signal. */
type Observation = Omit<AnonymousSignal, "id">;

const INSUFFICIENT_REASON =
  "no observation has a positive effective weight (confidence, source credibility and recency decay must all be above 0)";

/**
 * Assess how authentic a corpus of unattributed signals looks: a positive
 * composite of consensus/diversity/volume/recency, minus a penalty when the
 * evidence shows a pattern the heuristics discount.
 *
 * **Eligible evidence.** An observation is eligible only if its final
 * effective weight, source credibility x `confidence` x recency decay, is
 * above 0. Ineligible observations (zero confidence, an unclassified source
 * type, a source type configured with credibility 0, or an age that has
 * decayed the weight to exactly 0, such as `halfLifeDays: 0` or a date so old
 * the weight underflows) are still validated, but they contribute nothing to
 * the score, the components, the flags, `sourceCount`, or `confidence`:
 * removing them or adding more of them changes no output except `signalCount`.
 * An age that only lowers the weight (still above 0) does not make an
 * observation ineligible.
 *
 * **No eligible evidence.** The result is explicit: `confidence.level` is
 * `"insufficient"` (with a `reason`), `trustScore` is `null` (no score, not a
 * low score), every component is `0`, both flags are `false`, and
 * `explanation` says there is no usable evidence.
 *
 * Every accumulator (consensus, recency, and the astroturf mean/variance) is
 * summed with an order-independent, correctly-rounded algorithm (`exactSum`),
 * so the result does not depend on the order `signals` is given in. Each
 * caller-supplied field is read once, and `config` is validated (see
 * {@link resolveAnonymousConfig}).
 *
 * @throws TypeError if `options` is missing/not an object, `signals` is not an
 *   array or has a hole, an element is not an object, a `source` is not a
 *   string, `now`/a signal's `publishedAt` is neither a valid ISO 8601
 *   timestamp nor a `Date` (`now` only), or `config` is not a valid config.
 * @throws RangeError if `now` is an Invalid `Date`, a signal's `sentiment` is
 *   outside `[-1, 1]`, `confidence` is outside `[0, 1]`, or a derived value
 *   overflows.
 */
export function assessAuthenticity(
  signals: readonly AnonymousSignal[],
  config: AnonymousConfig,
  options: AssessAuthenticityOptions,
): AuthenticityAssessment {
  const list = snapshotArray(signals, "signals");
  const { now: rawNow } = checkRecord(options, "options");
  const now = checkClock(rawNow, "now");
  const resolved = readConfig(config);
  const observations = list.map((raw, index) => snapshotSignal(raw, `signals[${index}]`));

  // An observation is eligible only if its FINAL effective weight (source
  // credibility x confidence x recency decay) is above 0. One that has decayed
  // to nothing (halfLifeDays 0, or a date so old the weight underflows) carries
  // no evidence, so it must not raise sourceCount, diversity or confidence.
  // A publication date more than a day after `now` is not a usable date: it is
  // scored like a missing one (fail closed), never as perfectly fresh.
  const credibilityOf = sourceWeightLookup(resolved);
  const eligible: Observation[] = [];
  const labels: string[] = [];
  const weights: number[] = [];
  const decays: number[] = [];
  let futureDated = 0;
  let anyDated = false;
  for (const s of observations) {
    const label = normalizeSourceLabel(s.source);
    const credibility = credibilityOf(label);
    if (!(s.confidence > 0 && credibility > 0)) continue;
    const dated = typeof s.publishedAt === "string";
    const age = dated ? usableAgeDays(daysBetween(s.publishedAt as string, now)) : null;
    const decay = recencyDecay(age ?? resolved.recency.missingDateAgeDays, resolved.recency.halfLifeDays);
    const w = assertFinite(credibility * s.confidence * decay, "observation weight");
    if (w > 0) {
      eligible.push(s);
      labels.push(label);
      weights.push(w);
      decays.push(decay);
      if (age !== null) anyDated = true;
      else if (dated) futureDated += 1;
    }
  }
  if (eligible.length === 0) return insufficientAssessment(observations.length, resolved);

  // Every eligible weight is above 0, so the total is positive.
  const totalWeight = exactSum(weights);
  // Every configured credibility of an eligible observation is above 0, so this is too.
  const fullCount = FULL_COUNT_FRACTION * Math.max(...Object.values(resolved.sourceWeights));
  const { effectiveSources, sourceCount } = countSourceTypes(labels, weights, fullCount);
  // The uniformity minimum counts observations the same way: one at the
  // full-count weight or more counts as one, a lighter one in proportion.
  const effectiveObservations = snapNearInteger(exactSum(weights.map((w) => Math.min(1, w / fullCount))));

  // Volume: log-saturating effective count of source types.
  const volume = clamp01(Math.log1p(effectiveSources) / Math.log1p(resolved.volumeSaturation));

  // Diversity: effective source types against a fixed reference. It does not
  // divide by the observation count, so one observation does not get full
  // diversity and a confirming observation from a counted source type never
  // lowers it.
  const diversity = clamp01(effectiveSources / DIVERSITY_REFERENCE_SOURCES);

  // Consensus: recency- and confidence-weighted mean sentiment, weighted by
  // each source type's configured credibility.
  const meanSentiment = exactSum(eligible.map((s, i) => s.sentiment * (weights[i] as number))) / totalWeight;
  const consensus = clamp01((meanSentiment + 1) / 2);
  const recencyTerms = eligible.map((s, i) => (decays[i] as number) * s.confidence);
  // Every eligible confidence is above 0, so this denominator is positive.
  const recency = clamp01(exactSum(recencyTerms) / exactSum(eligible.map((s) => s.confidence)));

  const { penalty: astroturfPenalty, flags } = computeAstroturfPenalty({
    sentiments: eligible.map((s) => s.sentiment),
    weights,
    totalWeight,
    meanSentiment,
    effectiveSources,
    effectiveObservations,
    rules: resolved.astroturf,
  });

  const positive = assertFinite(
    resolved.weights.consensus * consensus +
      resolved.weights.diversity * diversity +
      resolved.weights.volume * volume +
      resolved.weights.recency * recency,
    "positive composite",
  );
  // Cap the composite BEFORE the discount, so weights that sum above 1 cannot
  // absorb it. astroturfPenalty is in [0, 1], so the product cannot exceed the
  // (finite) weight.
  const trustScore = Math.round(100 * clamp01(clamp01(positive) - resolved.astroturfWeight * astroturfPenalty));

  const components: AuthenticityComponents = { consensus, diversity, volume, recency, astroturfPenalty };

  return {
    trustScore,
    components,
    sourceCount,
    signalCount: observations.length,
    eligibleSignalCount: eligible.length,
    flags,
    confidence: confidenceFromSampleSize(sourceCount, resolved.confidence),
    explanation: explain({ trustScore, sourceCount, components, flags, anyDated, futureDated }),
  };
}

/**
 * The effective number of source types, and how many are counted. Each
 * normalized label adds `min(1, ownWeight / fullCount)`; `sourceCount` is the
 * number of labels at or above half of that, and at least 1. Summed exactly
 * and snapped, so the result does not depend on the order labels were first
 * seen or on the last bit of a sum.
 */
function countSourceTypes(
  labels: readonly string[],
  weights: readonly number[],
  fullCount: number,
): { effectiveSources: number; sourceCount: number } {
  const bySource = new Map<string, number[]>();
  labels.forEach((label, i) => {
    const terms = bySource.get(label);
    if (terms) terms.push(weights[i] as number);
    else bySource.set(label, [weights[i] as number]);
  });
  const parts: number[] = [];
  let counted = 0;
  for (const terms of bySource.values()) {
    const part = Math.min(1, snapNearInteger(exactSum(terms) / fullCount));
    if (part >= COUNTED_SOURCE_FRACTION) counted += 1;
    parts.push(part);
  }
  return { effectiveSources: snapNearInteger(exactSum(parts)), sourceCount: Math.max(1, counted) };
}

/** The documented outcome for a corpus with no eligible observation. */
function insufficientAssessment(submitted: number, config: AnonymousConfig): AuthenticityAssessment {
  const confidence = confidenceFromSampleSize(0, config.confidence);
  confidence.reason = INSUFFICIENT_REASON;
  return {
    trustScore: null,
    components: { consensus: 0, diversity: 0, volume: 0, recency: 0, astroturfPenalty: 0 },
    sourceCount: 0,
    signalCount: submitted,
    eligibleSignalCount: 0,
    flags: { lowSourceCount: false, uniformSentiment: false },
    confidence,
    explanation: `Insufficient evidence: ${INSUFFICIENT_REASON}, so no score is reported.`,
  };
}

/**
 * Heuristic score in `[0, 1]` for two patterns the heuristics discount. Either
 * can fire (their penalties add, capped at 1):
 *   - concentration: the eligible evidence comes from too few source types.
 *     Full penalty at/under `concentrationSourceCeiling` effective source
 *     types, ramping linearly to 0 one source type above it. It applies at any
 *     observation count: one review from one source type is as concentrated as
 *     thirty, so the discount does not switch on as reviews accumulate.
 *   - uniformity: weighted sentiment is near-maximal with near-zero weighted
 *     variance, from `minSignalsForUniformCheck` effective observations up.
 *     The penalty is `uniformPenalty x m x v^2`, where `m` is how far the mean
 *     is past its threshold (0 at the threshold, 1 at 0.05 past it, or at 1)
 *     and `v` how far the variance is below its threshold (0 at the threshold,
 *     1 at zero). It starts at 0 on both thresholds, so there is no cliff, and
 *     a near-weightless outlier cannot move the mean or variance.
 * Neither is a finding that any observation is fabricated. The caller passes
 * ELIGIBLE observations only, and there is at least one.
 */
function computeAstroturfPenalty(x: {
  sentiments: readonly number[];
  weights: readonly number[];
  totalWeight: number;
  meanSentiment: number;
  effectiveSources: number;
  effectiveObservations: number;
  rules: AstroturfRules;
}): { penalty: number; flags: AstroturfFlags } {
  const { rules } = x;
  const concentrationShare = clamp01(rules.concentrationSourceCeiling + 1 - x.effectiveSources);
  const concentration = rules.concentrationPenalty * concentrationShare;

  let uniformStrength = 0;
  if (x.effectiveObservations >= rules.minSignalsForUniformCheck) {
    const mean = x.meanSentiment;
    const variance =
      exactSum(x.sentiments.map((s, i) => (x.weights[i] as number) * (s - mean) ** 2)) / x.totalWeight;
    if (mean > rules.uniformMeanThreshold && variance < rules.uniformVarianceThreshold) {
      // Both thresholds are crossed strictly, so both denominators are above 0.
      const m = clamp01((mean - rules.uniformMeanThreshold) / Math.min(UNIFORM_MEAN_RAMP, 1 - rules.uniformMeanThreshold));
      const v = clamp01(1 - variance / rules.uniformVarianceThreshold);
      uniformStrength = m * v * v;
    }
  }
  const uniform = rules.uniformPenalty * uniformStrength;

  return {
    penalty: clamp01(concentration + uniform),
    flags: { lowSourceCount: concentrationShare > 0, uniformSentiment: uniformStrength > 0 },
  };
}

function explain(x: {
  trustScore: number;
  sourceCount: number;
  components: AuthenticityComponents;
  flags: AstroturfFlags;
  anyDated: boolean;
  futureDated: number;
}): string {
  const parts: string[] = [];
  parts.push(
    `Heuristic score ${x.trustScore}/100 from ${x.sourceCount} effective source type${x.sourceCount === 1 ? "" : "s"} (independence not verified).`,
  );
  if (x.components.consensus >= 0.7) parts.push("Sentiment is strongly positive.");
  else if (x.components.consensus <= 0.4) parts.push("Sentiment is lukewarm or negative.");
  if (x.components.diversity < 0.4) {
    parts.push("The evidence spans few distinct source types; treat as uncertain.");
  }
  if (x.components.recency < 0.4) {
    parts.push(
      x.anyDated
        ? "Recency is low given the publication dates supplied; observations without a date use the configured default age."
        : "No publication dates were supplied, so recency reflects only the configured default age and is uncertain.",
    );
  }
  if (x.futureDated > 0) {
    parts.push(
      `${x.futureDated} observation${x.futureDated === 1 ? " was" : "s were"} dated after the assessment time, so ${x.futureDated === 1 ? "it was" : "they were"} scored as undated.`,
    );
  }
  if (x.flags.uniformSentiment) {
    parts.push(
      "Sentiment is unusually uniform, which lowers the score. This is a pattern in the numbers, not a finding about the observations.",
    );
  }
  if (x.flags.lowSourceCount) {
    parts.push("Evidence comes from very few distinct source types, which lowers the score.");
  }
  return parts.join(" ");
}
