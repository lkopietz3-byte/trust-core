import { describe, expect, it } from "vitest";
import {
  assessAuthenticity,
  EXAMPLE_ANONYMOUS_CONFIG,
  resolveAnonymousConfig,
  type AnonymousConfig,
  type AnonymousSignal,
} from "./index.js";

/** Deterministic PRNG (mulberry32) so property tests are reproducible. */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Same generic "vendor directory" domain as identified/index.test.ts, but here
// the signals are unattributed — scraped mentions with no verifiable identity.
const NOW = "2026-08-01T00:00:00Z";

const config: AnonymousConfig = resolveAnonymousConfig({
  sourceWeights: { forum: 0.85, marketplace: 0.5, aggregator: 0.4, blog: 0.6 },
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
  // Only 4 source types are configured for this test file, so distinct
  // sourceCount tops out at 4 — thresholds are scaled to that ceiling.
  confidence: { high: 4, moderate: 2 },
});

let n = 0;
function sig(source: string, sentiment: number, overrides: Partial<AnonymousSignal> = {}): AnonymousSignal {
  n += 1;
  return {
    id: `sig-${n}`,
    source,
    sentiment,
    confidence: 0.9,
    publishedAt: "2026-07-15T00:00:00Z",
    ...overrides,
  };
}

describe("assessAuthenticity — flags manipulation", () => {
  it("flags astroturf on low source count (concentration) even with varied sentiment", () => {
    const concentrated = [
      sig("forum", 0.9),
      sig("forum", 0.3),
      sig("forum", -0.2),
      sig("forum", 0.6),
    ];

    const result = assessAuthenticity(concentrated, config, { now: NOW });

    expect(result.sourceCount).toBe(1);
    expect(result.flags.lowSourceCount).toBe(true);
    // Sentiment here has real spread, so the uniformity rule should NOT also fire.
    expect(result.flags.uniformSentiment).toBe(false);
    expect(result.components.astroturfPenalty).toBeGreaterThan(0);
  });

  it("flags astroturf on suspiciously uniform sentiment, even across multiple sources", () => {
    const planted = [
      sig("forum", 0.99),
      sig("marketplace", 0.98),
      sig("blog", 0.99),
      sig("aggregator", 1.0),
    ];

    const result = assessAuthenticity(planted, config, { now: NOW });

    expect(result.sourceCount).toBe(4);
    expect(result.flags.lowSourceCount).toBe(false);
    expect(result.flags.uniformSentiment).toBe(true);
    expect(result.components.astroturfPenalty).toBeGreaterThan(0);
  });

  it("scores flagged astroturf lower than an otherwise-comparable clean case", () => {
    const planted = [
      sig("forum", 0.99),
      sig("marketplace", 0.98),
      sig("blog", 0.99),
      sig("aggregator", 1.0),
    ];
    const genuine = [
      sig("forum", 0.75),
      sig("marketplace", 0.55),
      sig("blog", 0.8),
      sig("aggregator", 0.4),
    ];

    const plantedResult = assessAuthenticity(planted, config, { now: NOW });
    const genuineResult = assessAuthenticity(genuine, config, { now: NOW });

    expect(genuineResult.trustScore).not.toBeNull();
    expect(plantedResult.trustScore).toBeLessThan(genuineResult.trustScore as number);
  });
});

describe("assessAuthenticity — does not flag genuine diverse evidence", () => {
  it("leaves a diverse, varied-sentiment corpus unflagged with a solid trust score", () => {
    const genuine = [
      sig("forum", 0.7),
      sig("marketplace", 0.4),
      sig("blog", 0.8),
      sig("aggregator", 0.2),
      sig("forum", 0.6),
    ];

    const result = assessAuthenticity(genuine, config, { now: NOW });

    expect(result.sourceCount).toBe(4);
    expect(result.flags.lowSourceCount).toBe(false);
    expect(result.flags.uniformSentiment).toBe(false);
    expect(result.components.astroturfPenalty).toBe(0);
    expect(result.trustScore).toBeGreaterThan(50);
  });

  it("rewards diverse-source agreement over single-source volume, for the same mean sentiment", () => {
    const diverse = [sig("forum", 0.8), sig("marketplace", 0.8), sig("blog", 0.8), sig("aggregator", 0.8)];
    const concentrated = [sig("forum", 0.8), sig("forum", 0.8), sig("forum", 0.8), sig("forum", 0.8)];

    const diverseResult = assessAuthenticity(diverse, config, { now: NOW });
    const concentratedResult = assessAuthenticity(concentrated, config, { now: NOW });

    // Uniform-sentiment astroturf check aside, the diversity/volume terms
    // alone should favor the multi-source case.
    expect(diverseResult.components.diversity).toBeGreaterThan(concentratedResult.components.diversity);
    expect(diverseResult.components.volume).toBeGreaterThan(concentratedResult.components.volume);
  });
});

describe("assessAuthenticity — recency and confidence", () => {
  it("decays stale evidence relative to fresh evidence", () => {
    const fresh = [sig("forum", 0.7, { publishedAt: "2026-07-25T00:00:00Z" })];
    const stale = [sig("forum", 0.7, { publishedAt: "2018-01-01T00:00:00Z" })];

    const freshResult = assessAuthenticity(fresh, config, { now: NOW });
    const staleResult = assessAuthenticity(stale, config, { now: NOW });

    expect(freshResult.components.recency).toBeGreaterThan(staleResult.components.recency);
  });

  it("labels confidence from source count thresholds", () => {
    const thin = [sig("forum", 0.6)];
    const moderate = [sig("forum", 0.6), sig("marketplace", 0.5), sig("blog", 0.4)];
    const high = [
      sig("forum", 0.6),
      sig("marketplace", 0.5),
      sig("blog", 0.4),
      sig("aggregator", 0.5),
      sig("forum", 0.6),
      sig("marketplace", 0.5),
    ];

    expect(assessAuthenticity(thin, config, { now: NOW }).confidence.level).toBe("thin");
    expect(assessAuthenticity(moderate, config, { now: NOW }).confidence.level).toBe("moderate");
    expect(assessAuthenticity(high, config, { now: NOW }).confidence.level).toBe("high");
  });

  it("does not apply the astroturf check below the minimum-signal floor", () => {
    const tiny = [sig("forum", 1.0), sig("forum", 1.0)]; // 2 signals, uniform, single source
    const result = assessAuthenticity(tiny, config, { now: NOW });

    expect(result.flags.lowSourceCount).toBe(false);
    expect(result.flags.uniformSentiment).toBe(false);
    expect(result.components.astroturfPenalty).toBe(0);
  });
});

describe("README worked example reproduces exactly", () => {
  it("matches the exact numbers printed in README.md's anonymous example", () => {
    // Same config, signals, and options as the README's `anonymous` section.
    const readmeConfig = resolveAnonymousConfig({
      sourceWeights: { forum: 0.85, marketplace: 0.5, aggregator: 0.4, blog: 0.6 },
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
    const readmeSignals: AnonymousSignal[] = [
      { id: "s1", source: "forum", sentiment: 0.7, confidence: 0.9, publishedAt: "2026-07-01T00:00:00Z" },
      { id: "s2", source: "marketplace", sentiment: 0.4, confidence: 0.8, publishedAt: "2026-06-15T00:00:00Z" },
      { id: "s3", source: "blog", sentiment: 0.8, confidence: 0.85, publishedAt: "2026-05-20T00:00:00Z" },
    ];
    const verdict = assessAuthenticity(readmeSignals, readmeConfig, { now: "2026-08-01T00:00:00Z" });

    expect(verdict.trustScore).toBe(83);
    expect(verdict.components.consensus).toBeCloseTo(0.8288923795049216, 9);
    expect(verdict.components.diversity).toBe(1);
    expect(verdict.components.volume).toBeCloseTo(0.5404763088546395, 9);
    expect(verdict.components.recency).toBeCloseTo(0.9380486285411919, 9);
    expect(verdict.components.astroturfPenalty).toBe(0);
    expect(verdict.confidence).toEqual({ level: "moderate", effectiveSampleSize: 3 });
    expect(verdict.explanation).toBe(
      "Heuristic score 83/100 from 3 distinct source types (independence not verified). Sentiment is strongly positive.",
    );
    expect(verdict.eligibleSignalCount).toBe(3);
  });
});

describe("prototype-pollution keys are rejected, not silently miscomputed", () => {
  it("treats a source type named 'constructor' as unweighted (0), instead of NaN-poisoning consensus", () => {
    // Old code read `config.sourceWeights["constructor"]`, which resolved to
    // the inherited Object constructor function through the prototype chain
    // (not `undefined`), so `?? 0` never kicked in and the weight became NaN.
    const polluted = [sig("constructor", 0.9), sig("forum", 0.5)];
    const result = assessAuthenticity(polluted, config, { now: NOW });
    expect(Number.isNaN(result.trustScore)).toBe(false);
    expect(result.trustScore).toBeGreaterThanOrEqual(0);
    expect(result.trustScore).toBeLessThanOrEqual(100);
  });

  it("rejects an unrecognized dial-like prototype key in the weights config at construction time", () => {
    expect(() => resolveAnonymousConfig({ weights: { constructor: 1 } as never })).toThrow(TypeError);
  });
});

describe("input validation at the assessment boundary", () => {
  it("rejects sentiment outside [-1, 1]", () => {
    expect(() => assessAuthenticity([sig("forum", 1.5)], config, { now: NOW })).toThrow(RangeError);
    expect(() => assessAuthenticity([sig("forum", -1.5)], config, { now: NOW })).toThrow(RangeError);
  });

  it("rejects a NaN sentiment instead of letting it poison the mean/variance", () => {
    expect(() => assessAuthenticity([sig("forum", Number.NaN)], config, { now: NOW })).toThrow(RangeError);
  });

  it("rejects confidence outside [0, 1]", () => {
    expect(() => assessAuthenticity([sig("forum", 0.5, { confidence: 1.5 })], config, { now: NOW })).toThrow(
      RangeError,
    );
  });

  it("rejects a non-ISO publishedAt", () => {
    expect(() => assessAuthenticity([sig("forum", 0.5, { publishedAt: "June 1, 2026" })], config, { now: NOW })).toThrow();
  });

  it("rejects signals that are not an array", () => {
    expect(() => assessAuthenticity("nope" as never, config, { now: NOW })).toThrow(TypeError);
  });

  it("throws the kit's own TypeError when called without the required options argument, not a raw native error", () => {
    expect(() => (assessAuthenticity as (s: unknown, c: unknown) => unknown)([], config)).toThrow(TypeError);
    expect(() => (assessAuthenticity as (s: unknown, c: unknown) => unknown)([], config)).toThrow(/options must be an object/);
  });

  it("rejects a null options argument the same way", () => {
    expect(() => assessAuthenticity([], config, null as never)).toThrow(TypeError);
  });

  it("accepts a Date for `now`, matching the ISO-string result exactly", () => {
    const signals = [sig("forum", 0.6)];
    const asIso = assessAuthenticity(signals, config, { now: NOW });
    const asDate = assessAuthenticity(signals, config, { now: new Date(NOW) });
    expect(asDate).toEqual(asIso);
  });

  it("rejects an Invalid Date for `now`", () => {
    expect(() => assessAuthenticity([sig("forum", 0.6)], config, { now: new Date("not-a-date") })).toThrow(
      RangeError,
    );
  });

  it("accepts boundary sentiment values -1 and 1 without throwing", () => {
    expect(() => assessAuthenticity([sig("forum", 1), sig("marketplace", -1)], config, { now: NOW })).not.toThrow();
  });
});

describe("resolveAnonymousConfig — configuration validation", () => {
  it("rejects a negative source weight", () => {
    expect(() => resolveAnonymousConfig({ sourceWeights: { forum: -0.1 } })).toThrow(RangeError);
  });

  it("rejects NaN/Infinity in the positive-composite weights", () => {
    expect(() => resolveAnonymousConfig({ weights: { consensus: Number.NaN } as never })).toThrow(RangeError);
    expect(() => resolveAnonymousConfig({ weights: { volume: Number.POSITIVE_INFINITY } as never })).toThrow(
      RangeError,
    );
  });

  it("rejects a negative weight in the positive composite", () => {
    expect(() => resolveAnonymousConfig({ weights: { consensus: -0.5 } as never })).toThrow(RangeError);
  });

  it("rejects an unknown top-level key (a typo)", () => {
    expect(() => resolveAnonymousConfig({ sourceWeight: { forum: 0.5 } } as never)).toThrow(TypeError);
  });

  it("rejects an unknown key inside astroturf rules", () => {
    expect(() => resolveAnonymousConfig({ astroturf: { concentrationCeiling: 1 } as never })).toThrow(TypeError);
  });

  it("rejects volumeSaturation <= 0", () => {
    expect(() => resolveAnonymousConfig({ volumeSaturation: 0 })).toThrow(RangeError);
    expect(() => resolveAnonymousConfig({ volumeSaturation: -5 })).toThrow(RangeError);
  });

  it("rejects confidence.moderate greater than confidence.high", () => {
    expect(() => resolveAnonymousConfig({ confidence: { high: 2, moderate: 8 } })).toThrow(RangeError);
  });

  it("weights need not sum to 1 (README: 'normalized implicitly by how you set them', not divided by their sum)", () => {
    // Confirms the documented behavior directly: halving every weight halves
    // the positive composite pre-clamp, rather than the result being
    // renormalized back to the same trustScore.
    const half = resolveAnonymousConfig({ weights: { consensus: 0.2, diversity: 0.125, volume: 0.1, recency: 0.075 } });
    const full = resolveAnonymousConfig({ weights: { consensus: 0.4, diversity: 0.25, volume: 0.2, recency: 0.15 } });
    const signals = [sig("forum", 0.6), sig("marketplace", 0.5)];
    const halfResult = assessAuthenticity(signals, half, { now: NOW });
    const fullResult = assessAuthenticity(signals, full, { now: NOW });
    expect(fullResult.trustScore).not.toBeNull();
    expect(halfResult.trustScore).toBeLessThan(fullResult.trustScore as number);
  });
});

describe("exported configuration objects are frozen against mutation", () => {
  it("EXAMPLE_ANONYMOUS_CONFIG cannot be mutated, directly or through a nested weight map", () => {
    expect(Object.isFrozen(EXAMPLE_ANONYMOUS_CONFIG)).toBe(true);
    expect(Object.isFrozen(EXAMPLE_ANONYMOUS_CONFIG.sourceWeights)).toBe(true);
    expect(() => {
      EXAMPLE_ANONYMOUS_CONFIG.sourceWeights.forum = 999;
    }).toThrow(TypeError);
    expect(resolveAnonymousConfig().sourceWeights.forum).toBe(0.85);
  });

  it("a resolved config is itself frozen", () => {
    const cfg = resolveAnonymousConfig({ sourceWeights: { niche: 0.5 } });
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.sourceWeights)).toBe(true);
  });
});

describe("assessAuthenticity does not mutate its inputs", () => {
  it("leaves the signals array and its objects untouched", () => {
    const signals = [sig("forum", 0.7), sig("marketplace", 0.4)];
    const before = JSON.parse(JSON.stringify(signals)) as unknown;
    assessAuthenticity(signals, config, { now: NOW });
    expect(JSON.parse(JSON.stringify(signals))).toEqual(before);
  });
});

describe("property: authenticity invariants over randomized inputs (seeded)", () => {
  const rand = mulberry32(20260924);
  const sourceTypes = ["forum", "marketplace", "aggregator", "blog"] as const;

  function randomSignal(): AnonymousSignal {
    return sig(sourceTypes[Math.floor(rand() * sourceTypes.length)]!, rand() * 2 - 1, {
      confidence: rand(),
      publishedAt: rand() < 0.2 ? null : `202${Math.floor(rand() * 6)}-0${1 + Math.floor(rand() * 9)}-15T00:00:00Z`,
    });
  }

  it("trustScore is null exactly when evidence is insufficient, otherwise an integer in [0, 100]", () => {
    for (let trial = 0; trial < 200; trial++) {
      const n = Math.floor(rand() * 15);
      const signals = Array.from({ length: n }, randomSignal);
      const result = assessAuthenticity(signals, config, { now: NOW });
      if (result.confidence.level === "insufficient") {
        expect(result.trustScore).toBeNull();
        continue;
      }
      expect(result.trustScore).toBeGreaterThanOrEqual(0);
      expect(result.trustScore).toBeLessThanOrEqual(100);
      expect(Number.isInteger(result.trustScore)).toBe(true);
    }
  });

  it("is deterministic: the same input produces the exact same output every time", () => {
    for (let trial = 0; trial < 20; trial++) {
      const signals = Array.from({ length: 10 }, randomSignal);
      const a = assessAuthenticity(signals, config, { now: NOW });
      const b = assessAuthenticity(signals, config, { now: NOW });
      expect(a).toEqual(b);
    }
  });

  it("is order-independent: shuffling the signals does not change any component, even in the last bit", () => {
    for (let trial = 0; trial < 20; trial++) {
      const signals = Array.from({ length: 30 }, randomSignal);
      const shuffled = [...signals];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j] as AnonymousSignal, shuffled[i] as AnonymousSignal];
      }
      const a = assessAuthenticity(signals, config, { now: NOW });
      const b = assessAuthenticity(shuffled, config, { now: NOW });
      expect(b.components).toEqual(a.components);
      expect(b.trustScore).toBe(a.trustScore);
    }
  });

  it("consensus monotonicity: adding a maximum-sentiment signal never lowers consensus", () => {
    for (let trial = 0; trial < 100; trial++) {
      const base = Array.from({ length: 1 + Math.floor(rand() * 10) }, randomSignal);
      const before = assessAuthenticity(base, config, { now: NOW });
      const after = assessAuthenticity([...base, sig("forum", 1)], config, { now: NOW });
      expect(after.components.consensus).toBeGreaterThanOrEqual(before.components.consensus);
    }
  });

  it("handles empty signals without crashing and reports no score", () => {
    const result = assessAuthenticity([], config, { now: NOW });
    expect(result.sourceCount).toBe(0);
    expect(result.signalCount).toBe(0);
    expect(result.trustScore).toBeNull();
    expect(result.confidence.level).toBe("insufficient");
  });

  it("stays numerically well-behaved with a large number of signals (no NaN/Infinity)", () => {
    const many = Array.from({ length: 3000 }, randomSignal);
    const result = assessAuthenticity(many, config, { now: NOW });
    expect(Number.isFinite(result.trustScore)).toBe(true);
    expect(Number.isFinite(result.components.consensus)).toBe(true);
    expect(Number.isFinite(result.components.recency)).toBe(true);
  });
});

describe("derived values must stay finite or throw RangeError (TC-001)", () => {
  const good = [sig("forum", 0.5), sig("blog", 0.2), sig("marketplace", 0.1)];

  it("rejects a positive composite that overflows instead of reporting a plausible 100", () => {
    const huge = resolveAnonymousConfig({
      weights: { consensus: Number.MAX_VALUE, diversity: Number.MAX_VALUE, volume: 0, recency: 0 },
    });
    expect(() => assessAuthenticity(good, huge, { now: NOW })).toThrow(RangeError);
  });

  it("rejects Infinity - Infinity instead of returning a NaN trustScore", () => {
    const huge = resolveAnonymousConfig({
      weights: { consensus: Number.MAX_VALUE, diversity: Number.MAX_VALUE, volume: 0, recency: 0 },
      astroturfWeight: Number.MAX_VALUE,
    });
    const flagged = [sig("forum", 0.95), sig("forum", 0.95), sig("forum", 0.95)];
    expect(() => assessAuthenticity(flagged, huge, { now: NOW })).toThrow(RangeError);
  });

  it("rejects source credibility weights whose sum overflows", () => {
    const heavy = resolveAnonymousConfig({ sourceWeights: { forum: Number.MAX_VALUE, blog: Number.MAX_VALUE } });
    expect(() =>
      assessAuthenticity([sig("forum", 0.5, { confidence: 1 }), sig("blog", 0.5, { confidence: 1 })], heavy, { now: NOW }),
    ).toThrow(RangeError);
  });

  it("still accepts one very large but finite credibility weight", () => {
    const heavy = resolveAnonymousConfig({ sourceWeights: { forum: Number.MAX_VALUE } });
    const r = assessAuthenticity([sig("forum", 0.5, { confidence: 1 })], heavy, { now: NOW });
    expect(Number.isFinite(r.trustScore)).toBe(true);
  });
});
