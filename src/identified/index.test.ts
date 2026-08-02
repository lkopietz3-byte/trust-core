import { describe, expect, it } from "vitest";
import {
  composeDimensions,
  resolveIdentifiedConfig,
  scoreEntity,
  signalWeight,
  type IdentifiedConfig,
  type IdentifiedSignal,
} from "./index.js";

// A generic "vendor directory" domain: entries are rated by known,
// identified raters (buyers with accounts) at various tiers.
const NOW = "2026-08-01T00:00:00Z";

const config: IdentifiedConfig = resolveIdentifiedConfig({
  tierWeights: { new: 0.4, standard: 0.7, verified: 1.0, expert: 1.3 },
  sourceWeights: { imported: 0.5, direct: 1.0 },
  proofWeights: { none: 0.5, receipt: 1.15 },
  reputation: { floor: 0.6, ceil: 1.4, neutral: 1.0 },
  recency: { halfLifeDays: 365, missingDateAgeDays: 365 },
  confidence: { high: 8, moderate: 3 },
});

let n = 0;
function signal(overrides: Partial<IdentifiedSignal> = {}): IdentifiedSignal {
  n += 1;
  return {
    id: `sig-${n}`,
    tier: "standard",
    source: "direct",
    proof: "none",
    reputation: null,
    occurredAt: NOW,
    value: 80,
    ...overrides,
  };
}

describe("scoreEntity — shrinkage toward the prior", () => {
  it("pulls a thin single-signal score close to the prior", () => {
    const thin = [signal({ tier: "new", source: "imported", proof: "none", value: 90 })];

    const result = scoreEntity(thin, config, { asOf: NOW, prior: 50, dial: "balanced" });

    // One low-weight signal has almost no leverage against C=4 phantom prior
    // signals: the shrunk score should land much closer to the 50-point
    // prior than to the raw 90-point weighted mean.
    expect(result.raw).toBeCloseTo(90, 5);
    expect(result.score).toBeGreaterThan(50);
    expect(result.score).toBeLessThan(60);
    expect(result.nEff).toBeLessThan(1);
    expect(result.confidence.level).toBe("thin");
  });

  it("lets a deep, credible sample override the prior", () => {
    const deep = Array.from({ length: 12 }, () =>
      signal({ tier: "verified", source: "direct", proof: "receipt", reputation: 90, value: 90 }),
    );

    const result = scoreEntity(deep, config, { asOf: NOW, prior: 50, dial: "balanced" });

    expect(result.raw).toBeCloseTo(90, 5);
    // With many credible, fresh signals nEff should dwarf the C=4 dial, so
    // the shrunk score sits close to the raw mean, not the prior.
    expect(result.score).toBeGreaterThan(80);
    expect(result.confidence.level).toBe("high");
  });

  it("moves the score toward the raw mean as more evidence accumulates", () => {
    const one = [signal({ tier: "standard", value: 90 })];
    const five = Array.from({ length: 5 }, () => signal({ tier: "standard", value: 90 }));
    const twenty = Array.from({ length: 20 }, () => signal({ tier: "standard", value: 90 }));

    const scoreOne = scoreEntity(one, config, { asOf: NOW, prior: 50, dial: "balanced" }).score;
    const scoreFive = scoreEntity(five, config, { asOf: NOW, prior: 50, dial: "balanced" }).score;
    const scoreTwenty = scoreEntity(twenty, config, { asOf: NOW, prior: 50, dial: "balanced" }).score;

    expect(scoreOne).toBeLessThan(scoreFive);
    expect(scoreFive).toBeLessThan(scoreTwenty);
    expect(scoreTwenty).toBeLessThan(90); // still below raw, but converging
  });
});

describe("scoreEntity — the trust dial", () => {
  const evidence = Array.from({ length: 3 }, () =>
    signal({ tier: "verified", source: "direct", proof: "receipt", reputation: 80, value: 90 }),
  );

  it("strict pulls harder toward the prior than as_is, for identical evidence", () => {
    const prior = 50;
    const asIs = scoreEntity(evidence, config, { asOf: NOW, prior, dial: "as_is" });
    const balanced = scoreEntity(evidence, config, { asOf: NOW, prior, dial: "balanced" });
    const strict = scoreEntity(evidence, config, { asOf: NOW, prior, dial: "strict" });

    // Same signals -> same raw mean and nEff; only the dial differs.
    expect(asIs.raw).toBeCloseTo(balanced.raw!, 6);
    expect(balanced.raw).toBeCloseTo(strict.raw!, 6);

    // Monotonic ordering: prior <= strict <= balanced <= as_is <= raw,
    // because a bigger dial pulls harder toward the (lower) prior.
    expect(strict.score).toBeLessThan(balanced.score);
    expect(balanced.score).toBeLessThan(asIs.score);
    expect(asIs.score).toBeLessThan(evidence[0]!.value);
    expect(strict.score).toBeGreaterThan(prior);
  });

  it("accepts a caller-defined numeric C in place of a named preset", () => {
    const named = scoreEntity(evidence, config, { asOf: NOW, prior: 50, dial: "strict" });
    const custom = scoreEntity(evidence, config, { asOf: NOW, prior: 50, dial: 12 });

    expect(custom.score).toBeCloseTo(named.score, 10);
  });
});

describe("scoreEntity — recency and reputation", () => {
  it("decays an older signal's weight relative to a fresh one", () => {
    const fresh = signal({ occurredAt: "2026-07-25T00:00:00Z" });
    const stale = signal({ occurredAt: "2020-01-01T00:00:00Z" });

    const wFresh = signalWeight(fresh, config, NOW);
    const wStale = signalWeight(stale, config, NOW);

    expect(wFresh).toBeGreaterThan(wStale);
  });

  it("rewards higher reputation with a larger weight, within the configured bounds", () => {
    const low = signal({ reputation: 0 });
    const mid = signal({ reputation: null }); // neutral
    const high = signal({ reputation: 100 });

    const wLow = signalWeight(low, config, NOW);
    const wMid = signalWeight(mid, config, NOW);
    const wHigh = signalWeight(high, config, NOW);

    expect(wLow).toBeLessThan(wMid);
    expect(wMid).toBeLessThan(wHigh);
  });

  it("throws when a signal references a tier absent from the config", () => {
    const bad = signal({ tier: "nonexistent-tier" });
    expect(() => signalWeight(bad, config, NOW)).toThrow(/tier/i);
  });
});

describe("composeDimensions", () => {
  it("weighted-averages several dimension scores and ignores zero-weight dimensions", () => {
    const quality = scoreEntity(
      Array.from({ length: 5 }, () => signal({ tier: "verified", value: 90 })),
      config,
      { asOf: NOW, prior: 50 },
    );
    const reliability = scoreEntity(
      Array.from({ length: 5 }, () => signal({ tier: "verified", value: 60 })),
      config,
      { asOf: NOW, prior: 50 },
    );

    const composite = composeDimensions(
      { quality, reliability, ignored: quality },
      { quality: 2, reliability: 1, ignored: 0 },
    );

    const expected = (2 * quality.score + 1 * reliability.score) / 3;
    expect(composite).toBeCloseTo(expected, 10);
  });

  it("returns 0 when no dimension has a positive weight", () => {
    const quality = scoreEntity([signal()], config, { asOf: NOW, prior: 50 });
    expect(composeDimensions({ quality }, {})).toBe(0);
  });
});
