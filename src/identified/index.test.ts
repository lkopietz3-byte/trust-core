import { describe, expect, it } from "vitest";
import {
  composeDimensions,
  EXAMPLE_IDENTIFIED_CONFIG,
  resolveIdentifiedConfig,
  scoreEntity,
  signalWeight,
  TRUST_DIALS,
  type IdentifiedConfig,
  type IdentifiedSignal,
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

  it("treats a prototype-chain dimension key as absent instead of corrupting the composite", () => {
    const quality = scoreEntity([signal({ tier: "verified", value: 90 })], config, { asOf: NOW, prior: 50 });
    // "constructor" is not an own key of `weights` — old code read the
    // inherited Object constructor function through `weights[key]`, which
    // coerced to NaN in arithmetic and poisoned the whole composite.
    const composite = composeDimensions({ quality, constructor: quality }, { quality: 1 });
    expect(composite).toBe(quality.score);
    expect(Number.isNaN(composite)).toBe(false);
  });

  it("throws on a non-finite weight instead of silently producing NaN", () => {
    const quality = scoreEntity([signal()], config, { asOf: NOW, prior: 50 });
    expect(() => composeDimensions({ quality }, { quality: NaN })).toThrow(RangeError);
    expect(() => composeDimensions({ quality }, { quality: Infinity })).toThrow(RangeError);
  });
});

describe("prototype-pollution keys are rejected, not silently miscomputed", () => {
  it("throws a clear error for a signal tier named 'constructor', instead of returning NaN", () => {
    const bad = signal({ tier: "constructor" });
    expect(() => signalWeight(bad, config, NOW)).toThrow(/no weight configured for tier "constructor"/);
  });

  it("throws for 'toString' and '__proto__' source/proof keys too", () => {
    expect(() => signalWeight(signal({ source: "toString" }), config, NOW)).toThrow(/source/);
    expect(() => signalWeight(signal({ proof: "__proto__" }), config, NOW)).toThrow(/proof/);
  });

  it("resolveDial rejects a prototype-chain dial name with a clear RangeError, not a raw TypeError", () => {
    expect(() => scoreEntity([signal()], config, { asOf: NOW, prior: 50, dial: "constructor" as never })).toThrow(
      RangeError,
    );
  });

  it("resolveDial rejects an unrecognized preset name", () => {
    expect(() => scoreEntity([signal()], config, { asOf: NOW, prior: 50, dial: "aggressive" as never })).toThrow(
      /as_is|balanced|strict/,
    );
  });

  it("resolveDial rejects a negative numeric C", () => {
    expect(() => scoreEntity([signal()], config, { asOf: NOW, prior: 50, dial: -1 })).toThrow(RangeError);
  });
});

describe("input validation at the scoring boundary", () => {
  it("rejects a signal value above 100", () => {
    expect(() => signalWeight(signal({ value: 150 }), config, NOW)).toThrow(RangeError);
  });

  it("rejects a signal value below 0", () => {
    expect(() => signalWeight(signal({ value: -1 }), config, NOW)).toThrow(RangeError);
  });

  it("rejects a NaN signal value instead of letting it propagate into a NaN score", () => {
    expect(() => signalWeight(signal({ value: Number.NaN }), config, NOW)).toThrow(RangeError);
  });

  it("rejects out-of-range reputation", () => {
    expect(() => signalWeight(signal({ reputation: 150 }), config, NOW)).toThrow(RangeError);
    expect(() => signalWeight(signal({ reputation: Number.NaN }), config, NOW)).toThrow(RangeError);
  });

  it("rejects a non-ISO occurredAt instead of silently producing a NaN age", () => {
    expect(() => signalWeight(signal({ occurredAt: "not-a-date" }), config, NOW)).toThrow();
    expect(() => signalWeight(signal({ occurredAt: "2026-02-30" }), config, NOW)).toThrow(); // impossible date
  });

  it("rejects signals that are not an array", () => {
    expect(() => scoreEntity("not-an-array" as never, config, { asOf: NOW, prior: 50 })).toThrow(TypeError);
  });

  it("rejects a prior outside [0, 100] — an out-of-range prior would otherwise let the score escape the documented range", () => {
    expect(() => scoreEntity([signal()], config, { asOf: NOW, prior: 150 })).toThrow(RangeError);
    expect(() => scoreEntity([signal()], config, { asOf: NOW, prior: -1 })).toThrow(RangeError);
  });
});

describe("resolveIdentifiedConfig — configuration validation", () => {
  it("rejects a negative weight", () => {
    expect(() => resolveIdentifiedConfig({ tierWeights: { new: -0.1 } })).toThrow(RangeError);
  });

  it("rejects a NaN or Infinity weight", () => {
    expect(() => resolveIdentifiedConfig({ tierWeights: { new: Number.NaN } })).toThrow(RangeError);
    expect(() => resolveIdentifiedConfig({ sourceWeights: { direct: Number.POSITIVE_INFINITY } })).toThrow(
      RangeError,
    );
  });

  it("rejects an unknown top-level key (a typo)", () => {
    expect(() => resolveIdentifiedConfig({ tierWeight: { new: 0.4 } } as never)).toThrow(TypeError);
  });

  it("rejects an unknown key inside recency (e.g. a case typo)", () => {
    expect(() => resolveIdentifiedConfig({ recency: { halflifeDays: 100 } as never })).toThrow(TypeError);
  });

  it("rejects confidence.moderate greater than confidence.high", () => {
    expect(() => resolveIdentifiedConfig({ confidence: { high: 2, moderate: 8 } })).toThrow(RangeError);
  });

  it("rejects a negative reputation curve multiplier", () => {
    expect(() => resolveIdentifiedConfig({ reputation: { floor: -1, ceil: 1.4, neutral: 1.0 } })).toThrow(
      RangeError,
    );
  });

  it("accepts overrides that omit fields, filling them from the example config", () => {
    const cfg = resolveIdentifiedConfig({ tierWeights: { solo: 1 } });
    expect(cfg.tierWeights.solo).toBe(1);
    expect(cfg.tierWeights.new).toBe(EXAMPLE_IDENTIFIED_CONFIG.tierWeights.new);
  });
});

describe("exported configuration objects are frozen against mutation", () => {
  it("EXAMPLE_IDENTIFIED_CONFIG cannot be mutated, directly or through a nested weight map", () => {
    expect(Object.isFrozen(EXAMPLE_IDENTIFIED_CONFIG)).toBe(true);
    expect(Object.isFrozen(EXAMPLE_IDENTIFIED_CONFIG.tierWeights)).toBe(true);
    expect(() => {
      EXAMPLE_IDENTIFIED_CONFIG.tierWeights.new = 999;
    }).toThrow(TypeError);
    // A no-overrides call returns the same frozen singleton; confirm it still
    // reflects the untouched, original values.
    expect(resolveIdentifiedConfig().tierWeights.new).toBe(0.4);
  });

  it("TRUST_DIALS cannot be mutated", () => {
    expect(Object.isFrozen(TRUST_DIALS)).toBe(true);
    expect(Object.isFrozen(TRUST_DIALS.balanced)).toBe(true);
  });

  it("a resolved config is itself frozen, so later mutation attempts fail loudly rather than corrupting future scores", () => {
    const cfg = resolveIdentifiedConfig({ tierWeights: { solo: 1 } });
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.tierWeights)).toBe(true);
  });
});

describe("scoreEntity does not mutate its inputs", () => {
  it("leaves the signals array and its objects untouched", () => {
    const signals = [signal({ tier: "verified", value: 90 }), signal({ tier: "new", value: 40 })];
    const before = JSON.parse(JSON.stringify(signals)) as unknown;
    scoreEntity(signals, config, { asOf: NOW, prior: 50, dial: "balanced" });
    expect(JSON.parse(JSON.stringify(signals))).toEqual(before);
  });

  it("does not mutate the overrides object passed to resolveIdentifiedConfig", () => {
    const overrides = { tierWeights: { solo: 1 } };
    const before = JSON.parse(JSON.stringify(overrides)) as unknown;
    resolveIdentifiedConfig(overrides);
    expect(JSON.parse(JSON.stringify(overrides))).toEqual(before);
  });
});

describe("property: scoring invariants over randomized inputs (seeded)", () => {
  const rand = mulberry32(20260924);
  const tiers = ["new", "standard", "verified", "expert"] as const;
  const sources = ["imported", "direct"] as const;
  const proofs = ["none", "receipt"] as const;

  function randomSignal(): IdentifiedSignal {
    return signal({
      tier: tiers[Math.floor(rand() * tiers.length)],
      source: sources[Math.floor(rand() * sources.length)],
      proof: proofs[Math.floor(rand() * proofs.length)],
      reputation: rand() < 0.3 ? null : Math.floor(rand() * 101),
      occurredAt: rand() < 0.2 ? null : `202${Math.floor(rand() * 6)}-0${1 + Math.floor(rand() * 9)}-15T00:00:00Z`,
      value: Math.floor(rand() * 101),
    });
  }

  it("score and raw always stay within the documented [0, 100] range", () => {
    for (let trial = 0; trial < 200; trial++) {
      const n = Math.floor(rand() * 15);
      const signals = Array.from({ length: n }, randomSignal);
      const prior = Math.floor(rand() * 101);
      const dial = rand() < 0.5 ? (["as_is", "balanced", "strict"] as const)[Math.floor(rand() * 3)] : rand() * 20;
      const result = scoreEntity(signals, config, { asOf: NOW, prior, dial });
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      if (result.raw !== null) {
        expect(result.raw).toBeGreaterThanOrEqual(0);
        expect(result.raw).toBeLessThanOrEqual(100);
      }
    }
  });

  it("is deterministic: the same input produces the exact same output every time", () => {
    for (let trial = 0; trial < 20; trial++) {
      const signals = Array.from({ length: 10 }, randomSignal);
      const opts = { asOf: NOW, prior: 50, dial: "balanced" as const };
      const a = scoreEntity(signals, config, opts);
      const b = scoreEntity(signals, config, opts);
      expect(a).toEqual(b);
    }
  });

  it("is order-independent: shuffling the signals does not change score, raw, or nEff, even in the last bit", () => {
    for (let trial = 0; trial < 20; trial++) {
      const signals = Array.from({ length: 30 }, randomSignal);
      const shuffled = [...signals];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j] as IdentifiedSignal, shuffled[i] as IdentifiedSignal];
      }
      const opts = { asOf: NOW, prior: 50, dial: "balanced" as const };
      const a = scoreEntity(signals, config, opts);
      const b = scoreEntity(shuffled, config, opts);
      expect(b.nEff).toBe(a.nEff);
      expect(b.raw).toBe(a.raw);
      expect(b.score).toBe(a.score);
    }
  });

  it("monotonicity: adding a max-value signal never lowers the score; adding a min-value signal never raises it", () => {
    for (let trial = 0; trial < 100; trial++) {
      const base = Array.from({ length: 1 + Math.floor(rand() * 10) }, randomSignal);
      const opts = { asOf: NOW, prior: 50, dial: "balanced" as const };
      const before = scoreEntity(base, config, opts);

      const withMax = scoreEntity([...base, signal({ tier: "verified", value: 100 })], config, opts);
      expect(withMax.score).toBeGreaterThanOrEqual(before.score);

      const withMin = scoreEntity([...base, signal({ tier: "verified", value: 0 })], config, opts);
      expect(withMin.score).toBeLessThanOrEqual(before.score);
    }
  });

  it("handles empty signals with a defined, prior-equal score and no crash", () => {
    const result = scoreEntity([], config, { asOf: NOW, prior: 42, dial: "balanced" });
    expect(result.raw).toBeNull();
    expect(result.nEff).toBe(0);
    expect(result.score).toBeCloseTo(42, 10);
    expect(result.confidence.level).toBe("thin");
  });

  it("stays numerically well-behaved with a large number of tiny-weight signals (no NaN/Infinity, no drift)", () => {
    const many = Array.from({ length: 3000 }, () =>
      signal({ tier: "new", source: "imported", proof: "none", reputation: 1, value: Math.floor(rand() * 101) }),
    );
    const result = scoreEntity(many, config, { asOf: NOW, prior: 50, dial: "balanced" });
    expect(Number.isFinite(result.score)).toBe(true);
    expect(Number.isFinite(result.nEff)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
