/**
 * trust-core/anonymous — assess authenticity of UNATTRIBUTED, scraped signals.
 *
 * Use this when you don't know who's behind a signal: crawled mentions,
 * imported reviews with no verifiable identity, aggregator feeds. There is no
 * reputation to weight and no prior to shrink toward — instead the question
 * is "does this look like real, independent sentiment, or planted buzz?"
 *
 * The pattern:
 *   - `volume`    — log-scaled count of independent sources (saturating, so
 *                   the 50th source barely matters more than the 12th).
 *   - `diversity` — distinct sources relative to signal count. Eight signals
 *                   from five sources beats eight signals from one.
 *   - `consensus` — recency- and confidence-weighted mean sentiment, with
 *                   each source type weighted by a caller-supplied
 *                   "localness"/credibility factor.
 *   - `recency`   — how fresh the evidence is, on average.
 *   - `astroturfPenalty` — subtracted from the weighted-positive composite
 *                   when the evidence looks manipulated: concentrated in a
 *                   single source, or suspiciously uniform (near-maximal
 *                   sentiment with near-zero variance — the fingerprint of
 *                   copy-pasted or purchased praise).
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
  hasOwn,
  mergeSection,
  rejectUnknownKeys,
  snapshotArray,
  snapshotWeightMap,
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

export interface RecencyCurve {
  /** Days for the recency weight to halve. */
  halfLifeDays: number;
  /** Age (in days) assumed for signals with no `publishedAt`. */
  missingDateAgeDays: number;
}

/** Relative weighting of the four positive components. Need not sum to 1 — they're normalized implicitly by how you set them, but 1 keeps `trustScore` intuitive as a 0-100 scale. */
export interface AuthenticityWeights {
  consensus: number;
  diversity: number;
  volume: number;
  recency: number;
}

export interface AstroturfRules {
  /** Source count at/under which single-source concentration is penalized. */
  concentrationSourceCeiling: number;
  /** Penalty applied when source count is at/under the ceiling. */
  concentrationPenalty: number;
  /** Mean sentiment above this threshold is a candidate for the uniformity penalty. */
  uniformMeanThreshold: number;
  /** Sentiment variance below this threshold is a candidate for the uniformity penalty. */
  uniformVarianceThreshold: number;
  /** Penalty applied when both the mean and variance thresholds are crossed. */
  uniformPenalty: number;
  /** Minimum signal count before astroturf checks apply at all (avoids false positives on tiny n). */
  minSignalsForUniformCheck: number;
}

export interface AnonymousConfig {
  /** "Localness"/credibility weight per source type, `[0, 1]`ish. Unknown sources default to 0. */
  sourceWeights: Record<string, number>;
  weights: AuthenticityWeights;
  /** How much the astroturf penalty (`[0, 1]`) is subtracted from the positive composite. */
  astroturfWeight: number;
  recency: RecencyCurve;
  /** Source count at which the log-scaled volume term saturates to full credit. */
  volumeSaturation: number;
  astroturf: AstroturfRules;
  confidence: ConfidenceThresholds;
}

/**
 * An illustrative starting configuration — every number here is meant to be
 * overridden. Treat it as a worked example, not a domain default.
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

/** Validate every section once, copy the validated values, and freeze the result. */
function buildConfig(parts: Record<(typeof ANONYMOUS_CONFIG_KEYS)[number], unknown>): AnonymousConfig {
  return deepFreeze<AnonymousConfig>({
    sourceWeights: snapshotWeightMap(parts.sourceWeights, "sourceWeights"),
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
    sourceWeights: mergeSection(example.sourceWeights, sourceWeights, "sourceWeights"),
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
 * Look up a source type's credibility weight, checked with `Object.hasOwn`
 * so a prototype-chain name (`"constructor"`, `"toString"`, ...) falls back
 * to the documented "unknown source" default of 0 instead of resolving to an
 * inherited, non-numeric value that would corrupt the corpus's consensus and
 * recency accumulators with `NaN`. A legitimately unclassified source type
 * also defaults to 0 — anonymous corpora routinely include source types
 * nobody has classified yet, and a new, unweighted source shouldn't crash
 * the assessment. `source` is always a string here (the signal snapshot
 * checked it), so nothing is coerced into a property key.
 */
function sourceWeight(config: AnonymousConfig, source: string): number {
  return hasOwn(config.sourceWeights, source) ? config.sourceWeights[source]! : 0;
}

// ---------------------------------------------------------------------------
// Authenticity assessment
// ---------------------------------------------------------------------------

export interface AuthenticityComponents {
  consensus: number;
  diversity: number;
  volume: number;
  recency: number;
  /** `[0, 1]` — higher means a stronger pattern the heuristics discount. */
  astroturfPenalty: number;
}

export interface AstroturfFlags {
  /** True when the eligible evidence comes from too few distinct source types. */
  lowSourceCount: boolean;
  /** True when sentiment is near-maximal with near-zero variance. A pattern in the numbers, not a finding about any observation. */
  uniformSentiment: boolean;
}

export interface AuthenticityAssessment {
  /**
   * 0-100. When `confidence.level` is `"insufficient"` this is 0 by convention:
   * it means "no usable evidence", not "measured as untrustworthy". Check the
   * confidence level before reading the score.
   */
  trustScore: number;
  components: AuthenticityComponents;
  /** Distinct source types among ELIGIBLE observations. The source strings are caller-supplied labels; nothing verifies they are independent publishers. */
  sourceCount: number;
  /** How many observations were submitted (including ineligible ones). */
  signalCount: number;
  /** How many observations were eligible: confidence above 0 AND a source type with credibility above 0. Only these contribute to any other field. */
  eligibleSignalCount: number;
  flags: AstroturfFlags;
  /** `effectiveSampleSize` is `sourceCount`. `level` is `"insufficient"` (with a `reason`) when no observation is eligible. */
  confidence: Confidence;
  /** A plain-language summary of patterns and uncertainty. It states no conclusion about whether any observation is genuine, and does not say the sources are independent. */
  explanation: string;
}

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
  "no observation has both a confidence above 0 and a source type with credibility above 0";

/**
 * Assess how authentic a corpus of unattributed signals looks: a positive
 * composite of consensus/diversity/volume/recency, minus a penalty when the
 * evidence shows a pattern the heuristics discount.
 *
 * **Eligible evidence.** Only an observation with a `confidence` above 0 AND a
 * source type whose configured credibility is above 0 is eligible. Ineligible
 * observations (zero confidence, an unclassified source type, a source type
 * configured with credibility 0) are still validated, but they contribute
 * nothing to the score, the components, the flags, `sourceCount`, or
 * `confidence`: removing them or adding more of them changes no output except
 * `signalCount`. An observation's age lowers its weight; it does not make it
 * ineligible.
 *
 * **No eligible evidence.** The result is explicit: `confidence.level` is
 * `"insufficient"` (with a `reason`), `trustScore` is `0` by convention (not
 * a measurement), every component is `0`, both flags are `false`, and
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

  const eligible = observations.filter((s) => s.confidence > 0 && sourceWeight(resolved, s.source) > 0);
  if (eligible.length === 0) return insufficientAssessment(observations.length, resolved);

  const sources = new Set<string>();
  for (const s of eligible) sources.add(s.source);
  const sourceCount = sources.size;

  // Volume: log-saturating count of distinct source types.
  const volume = clamp01(Math.log1p(sourceCount) / Math.log1p(resolved.volumeSaturation));

  // Diversity: distinct source types relative to observation count (capped) —
  // many observations from one source type score low; the same count spread
  // across source types scores high.
  const diversity = clamp01(sourceCount / Math.min(eligible.length, 6));

  // Consensus: recency- and confidence-weighted mean sentiment, weighted by
  // each source type's configured credibility.
  const consensusTerms: number[] = [];
  const consensusWeights: number[] = [];
  const recencyTerms: number[] = [];
  const confidences: number[] = [];
  for (const s of eligible) {
    const age = s.publishedAt ? Math.max(0, daysBetween(s.publishedAt, now)) : resolved.recency.missingDateAgeDays;
    const decay = recencyDecay(age, resolved.recency.halfLifeDays);
    const w = sourceWeight(resolved, s.source) * s.confidence * decay;
    consensusTerms.push(s.sentiment * w);
    consensusWeights.push(w);
    recencyTerms.push(decay * s.confidence);
    confidences.push(s.confidence);
  }
  const consensusNum = exactSum(consensusTerms);
  const consensusDen = exactSum(consensusWeights);
  const meanSentiment = consensusDen > 0 ? consensusNum / consensusDen : 0;
  const consensus = clamp01((meanSentiment + 1) / 2);
  // Every eligible confidence is above 0, so this denominator is positive.
  const recency = clamp01(exactSum(recencyTerms) / exactSum(confidences));

  const { penalty: astroturfPenalty, flags } = computeAstroturfPenalty(eligible, sourceCount, resolved.astroturf);

  const positive = assertFinite(
    resolved.weights.consensus * consensus +
      resolved.weights.diversity * diversity +
      resolved.weights.volume * volume +
      resolved.weights.recency * recency,
    "positive composite",
  );
  // astroturfPenalty is in [0, 1], so this product cannot exceed the (finite) weight.
  const trustScore = Math.round(100 * clamp01(positive - resolved.astroturfWeight * astroturfPenalty));

  const components: AuthenticityComponents = { consensus, diversity, volume, recency, astroturfPenalty };

  return {
    trustScore,
    components,
    sourceCount,
    signalCount: observations.length,
    eligibleSignalCount: eligible.length,
    flags,
    confidence: confidenceFromSampleSize(sourceCount, resolved.confidence),
    explanation: explain({
      trustScore,
      sourceCount,
      components,
      flags,
      anyDated: eligible.some((s) => s.publishedAt !== null),
    }),
  };
}

/** The documented outcome for a corpus with no eligible observation. */
function insufficientAssessment(submitted: number, config: AnonymousConfig): AuthenticityAssessment {
  const confidence = confidenceFromSampleSize(0, config.confidence);
  confidence.reason = INSUFFICIENT_REASON;
  return {
    trustScore: 0,
    components: { consensus: 0, diversity: 0, volume: 0, recency: 0, astroturfPenalty: 0 },
    sourceCount: 0,
    signalCount: submitted,
    eligibleSignalCount: 0,
    flags: { lowSourceCount: false, uniformSentiment: false },
    confidence,
    explanation: `Insufficient evidence: ${INSUFFICIENT_REASON}, so no score is supported (0 is reported by convention).`,
  };
}

/**
 * Heuristic score in `[0, 1]` for two patterns the heuristics discount. Either
 * can fire (their penalties add, capped at 1):
 *   - concentration: the eligible evidence comes from too few source types.
 *   - uniformity: sentiment is near-maximal with near-zero variance.
 * Neither is a finding that any observation is fabricated. The caller passes
 * ELIGIBLE observations only, and there is at least one.
 */
function computeAstroturfPenalty(
  signals: readonly Observation[],
  sourceCount: number,
  rules: AstroturfRules,
): { penalty: number; flags: AstroturfFlags } {
  if (signals.length < rules.minSignalsForUniformCheck) {
    return { penalty: 0, flags: { lowSourceCount: false, uniformSentiment: false } };
  }

  const lowSourceCount = sourceCount <= rules.concentrationSourceCeiling;
  const concentration = lowSourceCount ? rules.concentrationPenalty : 0;

  const mean = exactSum(signals.map((s) => s.sentiment)) / signals.length;
  const variance = exactSum(signals.map((s) => (s.sentiment - mean) ** 2)) / signals.length;
  const uniformSentiment = mean > rules.uniformMeanThreshold && variance < rules.uniformVarianceThreshold;
  const uniform = uniformSentiment ? rules.uniformPenalty : 0;

  return { penalty: clamp01(concentration + uniform), flags: { lowSourceCount, uniformSentiment } };
}

function explain(x: {
  trustScore: number;
  sourceCount: number;
  components: AuthenticityComponents;
  flags: AstroturfFlags;
  anyDated: boolean;
}): string {
  const parts: string[] = [];
  parts.push(
    `Heuristic score ${x.trustScore}/100 from ${x.sourceCount} distinct source type${x.sourceCount === 1 ? "" : "s"} (independence not verified).`,
  );
  if (x.components.consensus >= 0.7) parts.push("Sentiment is strongly positive.");
  else if (x.components.consensus <= 0.4) parts.push("Sentiment is lukewarm or negative.");
  if (x.components.diversity < 0.4) {
    parts.push("Few distinct source types relative to the number of observations; treat as uncertain.");
  }
  if (x.components.recency < 0.4) {
    parts.push(
      x.anyDated
        ? "Recency is low given the publication dates supplied; observations without a date use the configured default age."
        : "No publication dates were supplied, so recency reflects only the configured default age and is uncertain.",
    );
  }
  if (x.flags.uniformSentiment) {
    parts.push(
      "Sentiment is unusually uniform, which lowers the score. This is a pattern in the numbers, not a finding about the observations.",
    );
  }
  if (x.flags.lowSourceCount && !x.flags.uniformSentiment) {
    parts.push("Evidence comes from very few distinct source types, which lowers the score.");
  }
  return parts.join(" ");
}
