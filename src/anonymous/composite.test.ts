import { describe, expect, it } from "vitest";
import { assessAuthenticity, resolveAnonymousConfig, type AnonymousConfig, type AnonymousSignal } from "./index.js";

const NOW = "2026-08-01T00:00:00Z";

/** Weight 1 for every listed source and no decay, so each component is easy to compute by hand. */
const BASE: AnonymousConfig = resolveAnonymousConfig({
  sourceWeights: { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 },
  weights: { consensus: 0, diversity: 0, volume: 0, recency: 0 },
  astroturfWeight: 0,
  recency: { halfLifeDays: Infinity, missingDateAgeDays: 0 },
  volumeSaturation: 3,
  astroturf: {
    concentrationSourceCeiling: 1,
    concentrationPenalty: 0.5,
    uniformMeanThreshold: 0.85,
    uniformVarianceThreshold: 0.02,
    uniformPenalty: 0.4,
    minSignalsForUniformCheck: 2,
  },
  confidence: { high: 4, moderate: 2 },
});
const withConfig = (overrides: Record<string, unknown>): AnonymousConfig => resolveAnonymousConfig({ ...BASE, ...overrides });
const sig = (source: string, sentiment: number, overrides: Partial<AnonymousSignal> = {}): AnonymousSignal => ({
  id: `${source}-${sentiment}`,
  source,
  sentiment,
  confidence: 1,
  publishedAt: NOW,
  ...overrides,
});
const assess = (signals: AnonymousSignal[], config: AnonymousConfig = BASE) => assessAuthenticity(signals, config, { now: NOW });

describe("each component enters the composite with its own weight", () => {
  const twoOfThree = [sig("a", 0.4), sig("b", 0.4), sig("a", 0.4)]; // 2 source types over 3 observations

  it("diversity", () => {
    const config = withConfig({ weights: { consensus: 0, diversity: 0.5, volume: 0, recency: 0 } });
    const result = assess(twoOfThree, config);
    expect(result.components.diversity).toBeCloseTo(2 / 3, 12);
    expect(result.trustScore).toBe(Math.round(100 * 0.5 * (2 / 3)));
  });

  it("volume", () => {
    const config = withConfig({ weights: { consensus: 0, diversity: 0, volume: 0.5, recency: 0 } });
    const result = assess(twoOfThree, config);
    expect(result.components.volume).toBeCloseTo(Math.log1p(2) / Math.log1p(3), 12);
    expect(result.trustScore).toBe(Math.round(100 * 0.5 * (Math.log1p(2) / Math.log1p(3))));
  });

  it("consensus", () => {
    const config = withConfig({ weights: { consensus: 0.5, diversity: 0, volume: 0, recency: 0 } });
    expect(assess(twoOfThree, config).trustScore).toBe(Math.round(100 * 0.5 * 0.7));
  });

  it("recency", () => {
    const stale = [sig("a", 0.4, { publishedAt: "2026-07-31T00:00:00Z" })];
    const config = withConfig({
      weights: { consensus: 0, diversity: 0, volume: 0, recency: 0.5 },
      recency: { halfLifeDays: 1, missingDateAgeDays: 0 },
    });
    const result = assess(stale, config);
    expect(result.components.recency).toBeCloseTo(0.5, 12);
    expect(result.trustScore).toBe(25);
  });

  it("the astroturf penalty subtracts penalty * astroturfWeight from the composite", () => {
    const config = withConfig({
      weights: { consensus: 1, diversity: 0, volume: 0, recency: 0 },
      astroturfWeight: 0.5,
    });
    const concentrated = [sig("a", 0.4), sig("a", 0.4)];
    const result = assess(concentrated, config);
    expect(result.flags.lowSourceCount).toBe(true);
    expect(result.components.astroturfPenalty).toBe(0.5);
    expect(result.trustScore).toBe(Math.round(100 * (0.7 - 0.5 * 0.5)));
  });

  it("the composite is clamped at 0 and at 100", () => {
    const low = withConfig({ weights: { consensus: 0, diversity: 0.1, volume: 0, recency: 0 }, astroturfWeight: 5 });
    expect(assess([sig("a", 0.4), sig("a", 0.4)], low).trustScore).toBe(0);
    const high = withConfig({ weights: { consensus: 3, diversity: 3, volume: 3, recency: 3 } });
    expect(assess([sig("a", 0.4), sig("b", 0.4)], high).trustScore).toBe(100);
  });
});

describe("the uniformity check at its boundaries", () => {
  const uniformFlag = (sentiments: number[], overrides: Record<string, unknown> = {}): boolean => {
    const sources = ["a", "b", "c", "d", "e", "f"];
    const config = withConfig({ astroturf: { ...BASE.astroturf, ...overrides } });
    return assess(
      sentiments.map((s, i) => sig(sources[i % sources.length] as string, s)),
      config,
    ).flags.uniformSentiment;
  };

  it("flags a high mean with a variance that is small but not zero (variance is divided by the count)", () => {
    // mean 0.95, sum of squared deviations 0.03, variance 0.0075 < 0.02
    expect(uniformFlag([1, 1, 1, 0.8])).toBe(true);
  });

  it("does not flag a high mean with a large variance", () => {
    expect(uniformFlag([1, 0.2, 1, 0.2], { uniformMeanThreshold: 0.5 })).toBe(false);
  });

  it("does not flag a tiny variance around a low mean", () => {
    expect(uniformFlag([0.2, 0.2, 0.2])).toBe(false);
  });

  it("requires the mean to be strictly above the threshold", () => {
    expect(uniformFlag([0.85, 0.85])).toBe(false);
    expect(uniformFlag([0.86, 0.86])).toBe(true);
  });

  it("requires the variance to be strictly below the threshold", () => {
    expect(uniformFlag([0.95, 0.95], { uniformVarianceThreshold: 0 })).toBe(false);
    expect(uniformFlag([0.95, 0.95], { uniformVarianceThreshold: 1e-9 })).toBe(true);
  });

  it("applies only from minSignalsForUniformCheck eligible observations", () => {
    expect(uniformFlag([0.95, 0.95], { minSignalsForUniformCheck: 3 })).toBe(false);
    expect(uniformFlag([0.95, 0.95, 0.95], { minSignalsForUniformCheck: 3 })).toBe(true);
  });

  it("concentration applies at the ceiling and not above it", () => {
    const config = withConfig({ astroturf: { ...BASE.astroturf, concentrationSourceCeiling: 2 } });
    expect(assess([sig("a", 0.1), sig("b", 0.1)], config).flags.lowSourceCount).toBe(true);
    expect(assess([sig("a", 0.1), sig("b", 0.1), sig("c", 0.1)], config).flags.lowSourceCount).toBe(false);
  });
});

describe("explanation thresholds at their exact boundaries", () => {
  // consensus = (mean + 1) / 2; these sentiments land exactly on 0.7 and 0.4 (verified in floating point).
  const SENTIMENT_FOR_CONSENSUS_0_7 = 1.4 - 1;
  const SENTIMENT_FOR_CONSENSUS_0_4 = 0.8 - 1;
  const text = (signals: AnonymousSignal[], config: AnonymousConfig = BASE): string => assess(signals, config).explanation;

  it("'strongly positive' starts at consensus 0.7 inclusive", () => {
    expect(assess([sig("a", SENTIMENT_FOR_CONSENSUS_0_7)]).components.consensus).toBe(0.7);
    expect(text([sig("a", SENTIMENT_FOR_CONSENSUS_0_7)])).toContain("Sentiment is strongly positive.");
    expect(text([sig("a", 0.39)])).not.toContain("strongly positive");
  });

  it("'lukewarm or negative' ends at consensus 0.4 inclusive", () => {
    expect(assess([sig("a", SENTIMENT_FOR_CONSENSUS_0_4)]).components.consensus).toBe(0.4);
    expect(text([sig("a", SENTIMENT_FOR_CONSENSUS_0_4)])).toContain("Sentiment is lukewarm or negative.");
    expect(text([sig("a", -0.1)])).not.toContain("lukewarm");
  });

  it("the few-source-types sentence needs diversity strictly below 0.4", () => {
    const five = (n: number): AnonymousSignal[] => Array.from({ length: 5 }, (_, i) => sig(["a", "b", "c"][i % n] as string, 0.1));
    expect(assess(five(2)).components.diversity).toBe(0.4);
    expect(text(five(2))).not.toContain("Few distinct source types");
    const six = Array.from({ length: 6 }, (_, i) => sig(["a", "b"][i % 2] as string, 0.1));
    expect(assess(six).components.diversity).toBeCloseTo(1 / 3, 12);
    expect(text(six)).toContain("Few distinct source types relative to the number of observations; treat as uncertain.");
  });

  it("the recency sentence needs recency strictly below 0.4", () => {
    const instant = withConfig({ recency: { halfLifeDays: 0, missingDateAgeDays: 0 } });
    const fresh = (): AnonymousSignal => sig("a", 0.1, { publishedAt: NOW });
    const stale = (source: string): AnonymousSignal => sig(source, 0.1, { publishedAt: "2020-01-01" });
    const atBoundary = [fresh(), fresh(), stale("b"), stale("c"), stale("d")];
    expect(assess(atBoundary, instant).components.recency).toBe(0.4);
    expect(text(atBoundary, instant)).not.toContain("Recency is low");
    const below = [fresh(), stale("b"), stale("c"), stale("d"), stale("e")];
    expect(assess(below, instant).components.recency).toBe(0.2);
    expect(text(below, instant)).toContain("Recency is low given the publication dates supplied");
  });

  it("a mix of dated and undated evidence uses the 'dates supplied' sentence, not the 'no dates' one", () => {
    const config = withConfig({ recency: { halfLifeDays: 30, missingDateAgeDays: 400 } });
    const mixed = [sig("a", 0.1, { publishedAt: "2020-01-01" }), sig("b", 0.1, { publishedAt: null })];
    const explanation = text(mixed, config);
    expect(explanation).toContain("Recency is low given the publication dates supplied");
    expect(explanation).not.toContain("No publication dates were supplied");
  });

  it("all-undated evidence uses the 'no dates' sentence", () => {
    const config = withConfig({ recency: { halfLifeDays: 30, missingDateAgeDays: 400 } });
    const undated = [sig("a", 0.1, { publishedAt: null }), sig("b", 0.1, { publishedAt: undefined })];
    expect(text(undated, config)).toContain("No publication dates were supplied");
  });

  it("uses the singular for one source type", () => {
    expect(text([sig("a", 0.1)])).toContain("from 1 distinct source type (independence not verified)");
    expect(text([sig("a", 0.1), sig("b", 0.1)])).toContain("from 2 distinct source types (independence not verified)");
  });
});

describe("recency and consensus edge cases", () => {
  it("when every eligible observation has zero recency weight, consensus is the neutral 0.5 and recency is 0", () => {
    const instant = withConfig({ recency: { halfLifeDays: 0, missingDateAgeDays: 0 } });
    const result = assess([sig("a", 1, { publishedAt: "2020-01-01" })], instant);
    expect(result.components.consensus).toBe(0.5);
    expect(result.components.recency).toBe(0);
  });

  it("recency is the confidence-weighted mean decay", () => {
    const config = withConfig({ recency: { halfLifeDays: 1, missingDateAgeDays: 0 } });
    const result = assess(
      [
        sig("a", 0.1, { confidence: 1, publishedAt: NOW }),
        sig("b", 0.1, { confidence: 0.5, publishedAt: "2026-07-31T00:00:00Z" }),
      ],
      config,
    );
    expect(result.components.recency).toBeCloseTo((1 * 1 + 0.5 * 0.5) / 1.5, 12);
  });

  it("a signal dated in the future counts as fresh, not as an error", () => {
    const config = withConfig({ recency: { halfLifeDays: 1, missingDateAgeDays: 0 } });
    expect(assess([sig("a", 0.1, { publishedAt: "2027-01-01" })], config).components.recency).toBe(1);
  });

  it("sentiment is weighted by source credibility x confidence x decay", () => {
    const config = withConfig({ sourceWeights: { a: 1, b: 0.5 } });
    const result = assess([sig("a", 1, { confidence: 1 }), sig("b", -1, { confidence: 0.5 })], config);
    // weights 1 and 0.25: mean = (1 - 0.25) / 1.25 = 0.6, consensus = 0.8
    expect(result.components.consensus).toBeCloseTo(0.8, 12);
  });

  it("volume saturates at volumeSaturation source types", () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((s) => sig(s, 0.1));
    expect(assess(six).components.volume).toBe(1);
    expect(assess([sig("a", 0.1)]).components.volume).toBeCloseTo(Math.log1p(1) / Math.log1p(3), 12);
  });

  it("an eligible observation with a tiny volumeSaturation saturates instead of overflowing", () => {
    const tiny = withConfig({ volumeSaturation: Number.MIN_VALUE });
    expect(assess([sig("a", 0.1)], tiny).components.volume).toBe(1);
  });
});
