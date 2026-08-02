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
export const EXAMPLE_ANONYMOUS_CONFIG: AnonymousConfig = {
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
};

/** Shallow-merge a partial override over {@link EXAMPLE_ANONYMOUS_CONFIG}. */
export function resolveAnonymousConfig(overrides?: Partial<AnonymousConfig>): AnonymousConfig {
  if (!overrides) return EXAMPLE_ANONYMOUS_CONFIG;
  return {
    sourceWeights: { ...EXAMPLE_ANONYMOUS_CONFIG.sourceWeights, ...overrides.sourceWeights },
    weights: { ...EXAMPLE_ANONYMOUS_CONFIG.weights, ...overrides.weights },
    astroturfWeight: overrides.astroturfWeight ?? EXAMPLE_ANONYMOUS_CONFIG.astroturfWeight,
    recency: { ...EXAMPLE_ANONYMOUS_CONFIG.recency, ...overrides.recency },
    volumeSaturation: overrides.volumeSaturation ?? EXAMPLE_ANONYMOUS_CONFIG.volumeSaturation,
    astroturf: { ...EXAMPLE_ANONYMOUS_CONFIG.astroturf, ...overrides.astroturf },
    confidence: { ...EXAMPLE_ANONYMOUS_CONFIG.confidence, ...overrides.confidence },
  };
}

function sourceWeight(config: AnonymousConfig, source: string): number {
  // Unknown source types default to 0 credibility rather than throwing —
  // anonymous corpora routinely include source types nobody has classified
  // yet, and a new, unweighted source shouldn't crash the assessment.
  return config.sourceWeights[source] ?? 0;
}

// ---------------------------------------------------------------------------
// Authenticity assessment
// ---------------------------------------------------------------------------

export interface AuthenticityComponents {
  consensus: number;
  diversity: number;
  volume: number;
  recency: number;
  /** `[0, 1]` — higher means more evidence of manipulation. */
  astroturfPenalty: number;
}

export interface AstroturfFlags {
  /** True when the evidence is concentrated in too few independent sources. */
  lowSourceCount: boolean;
  /** True when sentiment is near-maximal with near-zero variance — the planted-praise fingerprint. */
  uniformSentiment: boolean;
}

export interface AuthenticityAssessment {
  /** 0-100. */
  trustScore: number;
  components: AuthenticityComponents;
  sourceCount: number;
  signalCount: number;
  flags: AstroturfFlags;
  confidence: Confidence;
  /** Plain-English summary, safe to show a user under the score. */
  explanation: string;
}

export interface AssessAuthenticityOptions {
  /** ISO "now" recency decay is computed against. Pass a fixed value for determinism. */
  now: string;
}

/**
 * Assess how authentic a corpus of unattributed signals looks: a positive
 * composite of consensus/diversity/volume/recency, minus a penalty when the
 * evidence looks manipulated.
 */
export function assessAuthenticity(
  signals: readonly AnonymousSignal[],
  config: AnonymousConfig,
  options: AssessAuthenticityOptions,
): AuthenticityAssessment {
  const { now } = options;

  const sources = new Set<string>();
  for (const s of signals) sources.add(s.source);
  const sourceCount = sources.size;

  // Volume: log-saturating count of independent sources.
  const volume = clamp01(Math.log1p(sourceCount) / Math.log1p(config.volumeSaturation));

  // Diversity: distinct sources relative to signal count (capped) — many
  // signals from one source score low; the same count spread across sources
  // scores high.
  const diversity = signals.length === 0 ? 0 : clamp01(sourceCount / Math.min(signals.length, 6));

  // Consensus: recency- and confidence-weighted mean sentiment, weighted by
  // each source's configured credibility.
  let consensusNum = 0;
  let consensusDen = 0;
  let recencyNum = 0;
  let recencyDen = 0;
  for (const s of signals) {
    const age = s.publishedAt ? Math.max(0, daysBetween(s.publishedAt, now)) : config.recency.missingDateAgeDays;
    const decay = recencyDecay(age, config.recency.halfLifeDays);
    const w = sourceWeight(config, s.source) * s.confidence * decay;
    consensusNum += s.sentiment * w;
    consensusDen += w;
    recencyNum += decay * s.confidence;
    recencyDen += s.confidence;
  }
  const meanSentiment = consensusDen > 0 ? consensusNum / consensusDen : 0;
  const consensus = clamp01((meanSentiment + 1) / 2);
  const recency = recencyDen > 0 ? clamp01(recencyNum / recencyDen) : 0;

  const { penalty: astroturfPenalty, flags } = computeAstroturfPenalty(signals, sourceCount, config.astroturf);

  const positive =
    config.weights.consensus * consensus +
    config.weights.diversity * diversity +
    config.weights.volume * volume +
    config.weights.recency * recency;

  const trustScore = Math.round(100 * clamp01(positive - config.astroturfWeight * astroturfPenalty));

  const components: AuthenticityComponents = { consensus, diversity, volume, recency, astroturfPenalty };

  return {
    trustScore,
    components,
    sourceCount,
    signalCount: signals.length,
    flags,
    confidence: confidenceFromSampleSize(sourceCount, config.confidence),
    explanation: explain({ trustScore, sourceCount, components, flags }),
  };
}

/**
 * Heuristic manipulation score in `[0, 1]`. Two independent rules, either of
 * which can fire (their penalties add, capped at 1):
 *   - concentration: evidence backed by too few independent sources.
 *   - uniformity: sentiment is near-maximal with near-zero variance — no
 *     organic dissent, the fingerprint of copy-pasted or purchased praise.
 */
function computeAstroturfPenalty(
  signals: readonly AnonymousSignal[],
  sourceCount: number,
  rules: AstroturfRules,
): { penalty: number; flags: AstroturfFlags } {
  if (signals.length < rules.minSignalsForUniformCheck) {
    return { penalty: 0, flags: { lowSourceCount: false, uniformSentiment: false } };
  }

  const lowSourceCount = sourceCount <= rules.concentrationSourceCeiling;
  const concentration = lowSourceCount ? rules.concentrationPenalty : 0;

  const mean = signals.reduce((a, s) => a + s.sentiment, 0) / signals.length;
  const variance = signals.reduce((a, s) => a + (s.sentiment - mean) ** 2, 0) / signals.length;
  const uniformSentiment = mean > rules.uniformMeanThreshold && variance < rules.uniformVarianceThreshold;
  const uniform = uniformSentiment ? rules.uniformPenalty : 0;

  return { penalty: clamp01(concentration + uniform), flags: { lowSourceCount, uniformSentiment } };
}

function explain(x: {
  trustScore: number;
  sourceCount: number;
  components: AuthenticityComponents;
  flags: AstroturfFlags;
}): string {
  const parts: string[] = [];
  parts.push(
    `Trust ${x.trustScore}/100 across ${x.sourceCount} independent source${x.sourceCount === 1 ? "" : "s"}.`,
  );
  if (x.components.consensus >= 0.7) parts.push("Sentiment is strongly positive.");
  else if (x.components.consensus <= 0.4) parts.push("Sentiment is lukewarm or negative.");
  if (x.components.diversity < 0.4) parts.push("Evidence leans on very few sources — treat as provisional.");
  if (x.components.recency < 0.4) parts.push("Most evidence is dated.");
  if (x.flags.uniformSentiment) parts.push("Sentiment is suspiciously uniform; discounted as likely planted.");
  if (x.flags.lowSourceCount && !x.flags.uniformSentiment) {
    parts.push("Backed by very few independent sources; discounted.");
  }
  return parts.join(" ");
}
