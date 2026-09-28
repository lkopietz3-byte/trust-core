import { describe, expect, it } from "vitest";
import {
  assessAuthenticity,
  EXAMPLE_ANONYMOUS_CONFIG,
  resolveAnonymousConfig,
  type AnonymousSignal,
} from "./anonymous/index.js";
import {
  composeDimensions,
  EXAMPLE_IDENTIFIED_CONFIG,
  reputationFactor,
  resolveIdentifiedConfig,
  scoreEntity,
  signalAgeDays,
  signalWeight,
  type IdentifiedSignal,
} from "./identified/index.js";
import {
  confidenceFromSampleSize,
  daysBetween,
  recencyDecay,
  resolveDial,
  shrinkTowardPrior,
  TRUST_DIALS,
} from "./shared/types.js";
import { checkClock, checkNumber, checkArray, checkString, exactSum } from "./shared/internal.js";

/**
 * Error messages are the only place a caller learns WHICH field was wrong.
 * Each row pins the field name a message must carry, so a message that
 * silently loses its label fails here.
 */
const NOW = "2026-08-01T00:00:00Z";

const idSignal = (overrides: Record<string, unknown> = {}): IdentifiedSignal =>
  ({
    id: "s",
    tier: "standard",
    source: "direct",
    proof: "none",
    reputation: null,
    occurredAt: NOW,
    value: 50,
    ...overrides,
  });

const anSignal = (overrides: Record<string, unknown> = {}): AnonymousSignal =>
  ({ id: "s", source: "forum", sentiment: 0.5, confidence: 0.9, publishedAt: NOW, ...overrides });

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the call to throw");
}

const score = (signals: unknown[], config: unknown = EXAMPLE_IDENTIFIED_CONFIG, options: unknown = { now: NOW, prior: 50 }) =>
  scoreEntity(signals as IdentifiedSignal[], config as never, options as never);
const assess = (signals: unknown[], config: unknown = EXAMPLE_ANONYMOUS_CONFIG, options: unknown = { now: NOW }) =>
  assessAuthenticity(signals as AnonymousSignal[], config as never, options as never);

const identifiedRows: [string, () => unknown, string][] = [
  ["overrides not a record", () => resolveIdentifiedConfig(null as never), "overrides must be a plain object"],
  ["overrides typo", () => resolveIdentifiedConfig({ typo: 1 } as never), 'overrides: unknown key "typo"'],
  ["tierWeights not a record", () => resolveIdentifiedConfig({ tierWeights: 1 } as never), "tierWeights must be a plain object"],
  ["sourceWeights not a record", () => resolveIdentifiedConfig({ sourceWeights: 1 } as never), "sourceWeights must be a plain object"],
  ["proofWeights not a record", () => resolveIdentifiedConfig({ proofWeights: 1 } as never), "proofWeights must be a plain object"],
  ["reputation not a record", () => resolveIdentifiedConfig({ reputation: 1 } as never), "reputation must be a plain object"],
  ["recency not a record", () => resolveIdentifiedConfig({ recency: 1 } as never), "recency must be a plain object"],
  ["confidence not a record", () => resolveIdentifiedConfig({ confidence: 1 } as never), "confidence must be a plain object"],
  ["tier weight", () => resolveIdentifiedConfig({ tierWeights: { a: -1 } }), 'tierWeights["a"] must be a finite number >= 0'],
  ["source weight", () => resolveIdentifiedConfig({ sourceWeights: { a: -1 } }), 'sourceWeights["a"] must be'],
  ["proof weight", () => resolveIdentifiedConfig({ proofWeights: { a: -1 } }), 'proofWeights["a"] must be'],
  ["reputation.floor", () => resolveIdentifiedConfig({ reputation: { floor: -1 } as never }), "reputation.floor must be"],
  ["reputation.ceil", () => resolveIdentifiedConfig({ reputation: { ceil: -1 } as never }), "reputation.ceil must be"],
  ["reputation.neutral", () => resolveIdentifiedConfig({ reputation: { neutral: -1 } as never }), "reputation.neutral must be"],
  ["reputation typo", () => resolveIdentifiedConfig({ reputation: { typo: 1 } as never }), 'reputation: unknown key "typo"'],
  ["recency.halfLifeDays", () => resolveIdentifiedConfig({ recency: { halfLifeDays: -1 } as never }), "recency.halfLifeDays must be a number >= 0"],
  ["recency.missingDateAgeDays", () => resolveIdentifiedConfig({ recency: { missingDateAgeDays: Infinity } as never }), "recency.missingDateAgeDays must be a finite number >= 0"],
  ["recency typo", () => resolveIdentifiedConfig({ recency: { halflife: 1 } as never }), 'recency: unknown key "halflife"'],
  ["confidence.high", () => resolveIdentifiedConfig({ confidence: { high: -1, moderate: -2 } }), "confidence.high must be"],
  ["confidence.moderate", () => resolveIdentifiedConfig({ confidence: { high: 5, moderate: -1 } }), "confidence.moderate must be"],
  ["confidence order", () => resolveIdentifiedConfig({ confidence: { high: 1, moderate: 2 } }), "confidence.moderate (2) must not exceed confidence.high (1)"],
  ["confidence typo", () => resolveIdentifiedConfig({ confidence: { high: 2, moderate: 1, typo: 1 } as never }), 'confidence: unknown key "typo"'],
  ["config not a record", () => score([], null), "config must be a plain object"],
  ["config reputation not a record", () => score([], { ...EXAMPLE_IDENTIFIED_CONFIG, reputation: 1 }), "reputation must be a plain object"],
  [
    "unknown key lists the allowed keys",
    () => resolveIdentifiedConfig({ typo: 1 } as never),
    "(allowed: tierWeights, sourceWeights, proofWeights, reputation, recency, confidence)",
  ],
  ["config typo", () => score([], { ...EXAMPLE_IDENTIFIED_CONFIG, typo: 1 }), 'config: unknown key "typo"'],
  ["signals not an array", () => score({} as never), "signals must be an array"],
  ["signal id", () => score([idSignal({ id: 1 })]), "signals[0].id must be a string"],
  ["signal tier", () => score([idSignal({ tier: 1 })]), "signals[0].tier must be a string"],
  ["signal source", () => score([idSignal({ source: 1 })]), "signals[0].source must be a string"],
  ["signal proof", () => score([idSignal({ proof: 1 })]), "signals[0].proof must be a string"],
  ["signal reputation", () => score([idSignal({ reputation: 101 })]), "signals[0].reputation must be a finite number between 0 and 100"],
  ["signal occurredAt", () => score([idSignal({ occurredAt: "soon" })]), "signals[0].occurredAt must be an ISO 8601 timestamp"],
  ["signal value", () => score([idSignal({ value: 101 })]), "signals[0].value must be a finite number between 0 and 100"],
  ["second signal index", () => score([idSignal(), idSignal({ value: -1 })]), "signals[1].value"],
  ["options not a record", () => score([], EXAMPLE_IDENTIFIED_CONFIG, null), "options must be an object"],
  ["now", () => score([], EXAMPLE_IDENTIFIED_CONFIG, { now: 5, prior: 50 }), "now must be an ISO 8601 timestamp string"],
  ["prior", () => score([], EXAMPLE_IDENTIFIED_CONFIG, { now: NOW, prior: 101 }), "prior must be a finite number between 0 and 100"],
  ["signalWeight signal.id", () => signalWeight(idSignal({ id: 1 }), EXAMPLE_IDENTIFIED_CONFIG, NOW), "signal.id must be a string"],
  ["signalWeight signal.value", () => signalWeight(idSignal({ value: 101 }), EXAMPLE_IDENTIFIED_CONFIG, NOW), "signal.value must be"],
  ["signalWeight asOf", () => signalWeight(idSignal(), EXAMPLE_IDENTIFIED_CONFIG, "soon"), "asOf must be an ISO 8601 timestamp"],
  ["signalAgeDays asOf", () => signalAgeDays(null, "soon", EXAMPLE_IDENTIFIED_CONFIG.recency), "asOf must be"],
  ["signalAgeDays occurredAt", () => signalAgeDays("soon", NOW, EXAMPLE_IDENTIFIED_CONFIG.recency), "occurredAt must be"],
  ["reputationFactor", () => reputationFactor(101, EXAMPLE_IDENTIFIED_CONFIG.reputation), "reputation must be a finite number between 0 and 100"],
  ["unknown tier", () => score([idSignal({ tier: "x" })]), 'no weight configured for tier "x"'],
  ["unknown source", () => score([idSignal({ source: "x" })]), 'no weight configured for source "x"'],
  ["unknown proof", () => score([idSignal({ proof: "x" })]), 'no weight configured for proof "x"'],
  [
    "composeDimensions scores",
    () => composeDimensions(null as never, {}),
    "scores must be a plain object",
  ],
  ["composeDimensions weights", () => composeDimensions({}, null as never), "weights must be a plain object"],
  [
    "composeDimensions weight value",
    () => composeDimensions({ a: score([]) }, { a: Number.NaN }),
    'weights["a"] must be a finite number',
  ],
  ["composeDimensions entry", () => composeDimensions({ a: 5 as never }, { a: 1 }), 'scores["a"] must be an object'],
  [
    "composeDimensions entry score",
    () => composeDimensions({ a: { ...score([]), score: 101 } }, { a: 1 }),
    'scores["a"].score must be a finite number between 0 and 100',
  ],
  [
    "composeDimensions overflow",
    () => composeDimensions({ a: { ...score([]), score: 100 } }, { a: Number.MAX_VALUE }),
    'weighted score of dimension "a" is not a finite number',
  ],
];

const bigConfig = resolveIdentifiedConfig({
  tierWeights: { big: Number.MAX_VALUE },
  sourceWeights: { one: 1, big: Number.MAX_VALUE },
  proofWeights: { none: 1 },
  reputation: { floor: 1, ceil: 1, neutral: 1 },
  recency: { halfLifeDays: Infinity, missingDateAgeDays: 0 },
});

identifiedRows.push(
  [
    "weight overflow",
    () => score([idSignal({ tier: "big", source: "big", proof: "none", id: "w" })], bigConfig),
    'weight of signal "w" is not a finite number',
  ],
  [
    "weighted value overflow",
    () => score([idSignal({ tier: "big", source: "one", proof: "none", id: "v", value: 100 })], bigConfig),
    'weighted value of signal "v" is not a finite number',
  ],
);

const anonymousRows: [string, () => unknown, string][] = [
  ["overrides not a record", () => resolveAnonymousConfig(null as never), "overrides must be a plain object"],
  ["overrides typo", () => resolveAnonymousConfig({ typo: 1 } as never), 'overrides: unknown key "typo"'],
  ["sourceWeights not a record", () => resolveAnonymousConfig({ sourceWeights: 1 } as never), "sourceWeights must be a plain object"],
  ["weights not a record", () => resolveAnonymousConfig({ weights: 1 } as never), "weights must be a plain object"],
  ["recency not a record", () => resolveAnonymousConfig({ recency: 1 } as never), "recency must be a plain object"],
  ["astroturf not a record", () => resolveAnonymousConfig({ astroturf: 1 } as never), "astroturf must be a plain object"],
  ["confidence not a record", () => resolveAnonymousConfig({ confidence: 1 } as never), "confidence must be a plain object"],
  ["source weight", () => resolveAnonymousConfig({ sourceWeights: { a: -1 } }), 'sourceWeights["a"] must be a finite number >= 0'],
  ["weights typo", () => resolveAnonymousConfig({ weights: { typo: 1 } as never }), 'weights: unknown key "typo"'],
  ["weights.consensus", () => resolveAnonymousConfig({ weights: { consensus: -1 } as never }), "weights.consensus must be"],
  ["weights.diversity", () => resolveAnonymousConfig({ weights: { diversity: -1 } as never }), "weights.diversity must be"],
  ["weights.volume", () => resolveAnonymousConfig({ weights: { volume: -1 } as never }), "weights.volume must be"],
  ["weights.recency", () => resolveAnonymousConfig({ weights: { recency: -1 } as never }), "weights.recency must be"],
  ["astroturfWeight", () => resolveAnonymousConfig({ astroturfWeight: -1 }), "astroturfWeight must be a finite number >= 0"],
  ["volumeSaturation", () => resolveAnonymousConfig({ volumeSaturation: 0 }), "volumeSaturation must be a finite number > 0"],
  ["recency.halfLifeDays", () => resolveAnonymousConfig({ recency: { halfLifeDays: -1 } as never }), "recency.halfLifeDays must be"],
  ["confidence order", () => resolveAnonymousConfig({ confidence: { high: 1, moderate: 2 } }), "confidence.moderate (2) must not exceed confidence.high (1)"],
  ["astroturf typo", () => resolveAnonymousConfig({ astroturf: { typo: 1 } as never }), 'astroturf: unknown key "typo"'],
  [
    "astroturf.concentrationSourceCeiling",
    () => resolveAnonymousConfig({ astroturf: { concentrationSourceCeiling: -1 } as never }),
    "astroturf.concentrationSourceCeiling must be",
  ],
  [
    "astroturf.concentrationPenalty",
    () => resolveAnonymousConfig({ astroturf: { concentrationPenalty: -1 } as never }),
    "astroturf.concentrationPenalty must be",
  ],
  [
    "astroturf.uniformMeanThreshold",
    () => resolveAnonymousConfig({ astroturf: { uniformMeanThreshold: 2 } as never }),
    "astroturf.uniformMeanThreshold must be a finite number between -1 and 1",
  ],
  [
    "astroturf.uniformVarianceThreshold",
    () => resolveAnonymousConfig({ astroturf: { uniformVarianceThreshold: -1 } as never }),
    "astroturf.uniformVarianceThreshold must be",
  ],
  [
    "astroturf.uniformPenalty",
    () => resolveAnonymousConfig({ astroturf: { uniformPenalty: -1 } as never }),
    "astroturf.uniformPenalty must be",
  ],
  [
    "astroturf.minSignalsForUniformCheck",
    () => resolveAnonymousConfig({ astroturf: { minSignalsForUniformCheck: -1 } as never }),
    "astroturf.minSignalsForUniformCheck must be",
  ],
  ["config not a record", () => assess([], null), "config must be a plain object"],
  ["config weights not a record", () => assess([], { ...EXAMPLE_ANONYMOUS_CONFIG, weights: 1 }), "weights must be a plain object"],
  ["config astroturf not a record", () => assess([], { ...EXAMPLE_ANONYMOUS_CONFIG, astroturf: 1 }), "astroturf must be a plain object"],
  ["config typo", () => assess([], { ...EXAMPLE_ANONYMOUS_CONFIG, typo: 1 }), 'config: unknown key "typo"'],
  ["signals not an array", () => assess({} as never), "signals must be an array"],
  ["options not a record", () => assess([], EXAMPLE_ANONYMOUS_CONFIG, null), "options must be an object"],
  ["now", () => assess([], EXAMPLE_ANONYMOUS_CONFIG, { now: 5 }), "now must be an ISO 8601 timestamp string"],
  ["signal source", () => assess([anSignal({ source: 1 })]), "signals[0].source must be a string"],
  ["signal sentiment", () => assess([anSignal({ sentiment: 2 })]), "signals[0].sentiment must be a finite number between -1 and 1"],
  ["signal confidence", () => assess([anSignal({ confidence: 2 })]), "signals[0].confidence must be a finite number between 0 and 1"],
  ["signal publishedAt", () => assess([anSignal({ publishedAt: "soon" })]), "signals[0].publishedAt must be an ISO 8601 timestamp"],
  ["second signal index", () => assess([anSignal(), anSignal({ sentiment: 2 })]), "signals[1].sentiment"],
  [
    "positive composite overflow",
    () =>
      assess(
        [anSignal(), anSignal({ source: "blog" })],
        resolveAnonymousConfig({ weights: { consensus: Number.MAX_VALUE, diversity: Number.MAX_VALUE, volume: 0, recency: 0 } }),
      ),
    "positive composite is not a finite number",
  ],
];

describe("error messages name the offending field: identified", () => {
  it.each(identifiedRows)("%s", (_name, run, expected) => {
    expect(messageOf(run)).toContain(expected);
  });
});

describe("error messages name the offending field: anonymous", () => {
  it.each(anonymousRows)("%s", (_name, run, expected) => {
    expect(messageOf(run)).toContain(expected);
  });
});

describe("error messages name the offending field: shared", () => {
  const rows: [string, () => unknown, string][] = [
    ["daysBetween toISO", () => daysBetween("2026-01-01", "soon"), "toISO must be an ISO 8601 timestamp"],
    ["daysBetween fromISO", () => daysBetween("soon", "2026-01-01"), "fromISO must be an ISO 8601 timestamp"],
    ["recencyDecay ageDays", () => recencyDecay(Number.NaN, 1), "ageDays must be a number"],
    ["recencyDecay halfLifeDays", () => recencyDecay(1, Number.NaN), "halfLifeDays must be a number"],
    ["shrink weightedSum", () => shrinkTowardPrior(Number.NaN, 1, 50, 4), "weightedSum must be a finite number"],
    ["shrink totalWeight", () => shrinkTowardPrior(1, -1, 50, 4), "totalWeight must be a finite number >= 0"],
    ["shrink prior", () => shrinkTowardPrior(1, 1, Number.NaN, 4), "prior must be a finite number"],
    ["shrink dial", () => shrinkTowardPrior(1, 1, 50, -1), "dial must be a finite number >= 0"],
    ["shrink denominator", () => shrinkTowardPrior(1, Number.MAX_VALUE, 50, Number.MAX_VALUE), "shrinkage denominator (totalWeight + dial) is not a finite number"],
    ["shrink prior term", () => shrinkTowardPrior(1, 1, 50, Number.MAX_VALUE), "shrinkage prior term (dial * prior) is not a finite number"],
    ["shrink numerator", () => shrinkTowardPrior(Number.MAX_VALUE, 1, Number.MAX_VALUE, 1), "shrinkage numerator (weightedSum + dial * prior) is not a finite number"],
    ["shrink quotient", () => shrinkTowardPrior(1e10, 5e-324, 50, 0), "shrunk score is not a finite number"],
    ["resolveDial number", () => resolveDial(-1), "dial must be a finite number >= 0"],
    ["resolveDial type", () => resolveDial(null as never), "dial must be a preset name (as_is, balanced, strict) or a non-negative number (got null)"],
    ["resolveDial name", () => resolveDial("nope" as never), 'dial must be one of as_is, balanced, strict, or a non-negative number (got "nope")'],
    ["confidence sample size", () => confidenceFromSampleSize(-1, { high: 2, moderate: 1 }), "effectiveSampleSize must be a number >= 0"],
    ["confidence thresholds", () => confidenceFromSampleSize(1, null as never), "thresholds must be a plain object"],
    ["exactSum term", () => exactSum([Number.NaN]), "a term being summed is not a finite number"],
    ["exactSum overflow", () => exactSum([Number.MAX_VALUE, Number.MAX_VALUE]), "floating-point overflow while summing weights"],
    ["checkNumber type", () => checkNumber("1", "x"), 'x must be a number (got "1")'],
    ["checkNumber NaN, no bounds", () => checkNumber(Number.NaN, "x"), "x must be a finite number (got NaN)"],
    ["checkNumber NaN, infinity allowed", () => checkNumber(Number.NaN, "x", { allowInfinity: true }), "x must be a number (got NaN)"],
    ["checkNumber max only", () => checkNumber(2, "x", { max: 1 }), "x must be a finite number <= 1 (got 2)"],
    ["checkArray", () => checkArray(1, "xs"), "xs must be an array (got 1)"],
    ["checkString", () => checkString(1, "s"), "s must be a string (got 1)"],
    ["checkClock invalid date", () => checkClock(new Date("nonsense"), "now"), "now must be a valid Date (got an Invalid Date)"],
  ];

  it.each(rows)("%s", (_name, run, expected) => {
    expect(messageOf(run)).toContain(expected);
  });

  it("the dial presets keep their documented labels, descriptions and strengths", () => {
    expect(TRUST_DIALS.as_is).toEqual({
      C: 0.5,
      label: "As-is",
      description:
        "Trust the credibility-weighted average with almost no shrinkage (a hair of pull avoids a bare 0-signal blow-up).",
    });
    expect(TRUST_DIALS.balanced).toEqual({
      C: 4,
      label: "Balanced",
      description: "Pull thin evidence gently toward the baseline. Sensible default.",
    });
    expect(TRUST_DIALS.strict).toEqual({
      C: 12,
      label: "Strict",
      description: "Demand deep, credible evidence before a score is allowed to stand on its own.",
    });
  });
});
