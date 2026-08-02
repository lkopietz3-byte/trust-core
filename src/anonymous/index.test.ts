import { describe, expect, it } from "vitest";
import { assessAuthenticity, resolveAnonymousConfig, type AnonymousConfig, type AnonymousSignal } from "./index.js";

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

    expect(plantedResult.trustScore).toBeLessThan(genuineResult.trustScore);
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
