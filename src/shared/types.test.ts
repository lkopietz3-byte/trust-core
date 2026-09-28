import { describe, expect, it } from "vitest";
import {
  clamp,
  clamp01,
  confidenceFromSampleSize,
  daysBetween,
  recencyDecay,
  resolveDial,
  shrinkTowardPrior,
  TRUST_DIALS,
} from "./types.js";

describe("clamp / clamp01", () => {
  it("clamps a value into [min, max]", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it("clamp01 clamps into [0, 1]", () => {
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
  });

  it("propagates NaN rather than masking it — validation happens at the caller boundary, not here", () => {
    expect(Number.isNaN(clamp(Number.NaN, 0, 10))).toBe(true);
    expect(Number.isNaN(clamp01(Number.NaN))).toBe(true);
  });
});

describe("daysBetween", () => {
  it("computes whole days when timestamps are exactly N days apart", () => {
    expect(daysBetween("2026-01-01T00:00:00Z", "2026-01-11T00:00:00Z")).toBe(10);
  });

  it("is fractional (not rounded) for a sub-day difference, matching its documented contract", () => {
    expect(daysBetween("2026-01-01T00:00:00Z", "2026-01-01T12:00:00Z")).toBeCloseTo(0.5, 10);
  });

  it("is negative when toISO is earlier than fromISO", () => {
    expect(daysBetween("2026-01-11T00:00:00Z", "2026-01-01T00:00:00Z")).toBe(-10);
  });

  it("is zero for identical timestamps", () => {
    expect(daysBetween("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")).toBe(0);
  });
});

describe("recencyDecay", () => {
  it("is 1 at age 0 and halves at the half-life", () => {
    expect(recencyDecay(0, 100)).toBe(1);
    expect(recencyDecay(100, 100)).toBeCloseTo(0.5, 10);
    expect(recencyDecay(200, 100)).toBeCloseTo(0.25, 10);
  });

  it("treats halfLifeDays = 0 as instant full decay past age 0, but full weight at age 0", () => {
    expect(recencyDecay(0, 0)).toBe(1);
    expect(recencyDecay(1, 0)).toBe(0);
  });

  it("treats halfLifeDays = Infinity as never decaying", () => {
    expect(recencyDecay(1_000_000, Infinity)).toBe(1);
  });

  it("does not penalize a negative age (a signal dated in the future relative to asOf)", () => {
    expect(recencyDecay(-50, 100)).toBe(1);
  });
});

describe("shrinkTowardPrior", () => {
  it("collapses to the prior exactly when there is no evidence", () => {
    expect(shrinkTowardPrior(0, 0, 55, 4)).toBe(55);
  });

  it("collapses to the prior exactly even when dial is also 0 (0/0 case)", () => {
    // Regression: (weightedSum + dial*prior) / (totalWeight + dial) is 0/0
    // when both totalWeight and dial are 0, which is NaN unless special-cased.
    // A caller who explicitly asks for zero shrinkage should still get a
    // defined score when there is also zero evidence, per this function's
    // own documented "no evidence still yields a defined score" guarantee.
    expect(shrinkTowardPrior(0, 0, 55, 0)).toBe(55);
  });

  it("returns the unshrunk mean when dial is 0 and there IS evidence", () => {
    expect(shrinkTowardPrior(180, 2, 55, 0)).toBe(90); // 180/2, prior ignored
  });

  it("converges toward the raw mean as totalWeight grows past dial", () => {
    const thin = shrinkTowardPrior(90, 1, 50, 4); // mostly prior
    const deep = shrinkTowardPrior(90 * 100, 100, 50, 4); // mostly raw mean
    expect(thin).toBeLessThan(deep);
    expect(deep).toBeGreaterThan(85);
  });
});

describe("confidenceFromSampleSize", () => {
  const thresholds = { high: 8, moderate: 3 };

  it("labels exactly at the high threshold as high (>=, not >)", () => {
    expect(confidenceFromSampleSize(8, thresholds).level).toBe("high");
  });

  it("labels just below the high threshold as moderate", () => {
    expect(confidenceFromSampleSize(7.999, thresholds).level).toBe("moderate");
  });

  it("labels exactly at the moderate threshold as moderate (>=, not >)", () => {
    expect(confidenceFromSampleSize(3, thresholds).level).toBe("moderate");
  });

  it("labels just below the moderate threshold as thin", () => {
    expect(confidenceFromSampleSize(2.999, thresholds).level).toBe("thin");
  });

  it("labels 0 as thin", () => {
    expect(confidenceFromSampleSize(0, thresholds).level).toBe("thin");
  });

  it("carries the effective sample size through unchanged", () => {
    expect(confidenceFromSampleSize(5.5, thresholds).effectiveSampleSize).toBe(5.5);
  });
});

describe("TRUST_DIALS / resolveDial", () => {
  it("exposes the three documented presets with the expected strengths", () => {
    expect(TRUST_DIALS.as_is.C).toBe(0.5);
    expect(TRUST_DIALS.balanced.C).toBe(4);
    expect(TRUST_DIALS.strict.C).toBe(12);
  });

  it("resolves a preset name to its C", () => {
    expect(resolveDial("balanced")).toBe(4);
  });

  it("passes a raw non-negative number through unchanged", () => {
    expect(resolveDial(7)).toBe(7);
    expect(resolveDial(0)).toBe(0);
  });

  it("rejects a negative number", () => {
    expect(() => resolveDial(-1)).toThrow(RangeError);
  });

  it("rejects NaN/Infinity", () => {
    expect(() => resolveDial(Number.NaN)).toThrow(RangeError);
    expect(() => resolveDial(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("rejects an unrecognized preset name with a clear RangeError, not a raw TypeError", () => {
    expect(() => resolveDial("aggressive" as never)).toThrow(RangeError);
  });

  it("rejects a prototype-chain preset name", () => {
    expect(() => resolveDial("constructor" as never)).toThrow(RangeError);
  });

  it("TRUST_DIALS and its entries are frozen", () => {
    expect(Object.isFrozen(TRUST_DIALS)).toBe(true);
    expect(Object.isFrozen(TRUST_DIALS.balanced)).toBe(true);
  });
});

describe("derived values must stay finite (TC-001)", () => {
  it("shrinkTowardPrior rejects a dial*prior product that overflows instead of returning an overflow-clamped result", () => {
    expect(() => shrinkTowardPrior(50, 1, 50, Number.MAX_VALUE)).toThrow(RangeError);
  });

  it("shrinkTowardPrior rejects a totalWeight+dial sum that overflows (it would otherwise divide to a plausible 0)", () => {
    expect(() => shrinkTowardPrior(1, Number.MAX_VALUE, 50, Number.MAX_VALUE)).toThrow(RangeError);
  });

  it("shrinkTowardPrior rejects a numerator that overflows", () => {
    expect(() => shrinkTowardPrior(Number.MAX_VALUE, 1, Number.MAX_VALUE, 4)).toThrow(RangeError);
  });

  it("shrinkTowardPrior rejects NaN inputs instead of returning NaN", () => {
    expect(() => shrinkTowardPrior(Number.NaN, 1, 50, 4)).toThrow(RangeError);
  });

  it("still returns large finite results when nothing overflows", () => {
    expect(shrinkTowardPrior(5e300, 1e299, 50, 4)).toBeCloseTo(50, 5);
  });

  it("recencyDecay rejects NaN age or half-life instead of returning NaN", () => {
    expect(() => recencyDecay(Number.NaN, 100)).toThrow(RangeError);
    expect(() => recencyDecay(1, Number.NaN)).toThrow(RangeError);
  });

  it("daysBetween rejects a malformed timestamp instead of returning NaN", () => {
    expect(() => daysBetween("garbage", "2026-01-01T00:00:00Z")).toThrow(RangeError);
    expect(() => daysBetween("2026-01-01T00:00:00Z", "2026-13-01")).toThrow(RangeError);
    expect(() => daysBetween("2026-01-01T00:00:00Z", 5 as never)).toThrow(TypeError);
  });

  it("daysBetween ignores the process time zone: a zone-less date-time is rejected, not read as local", () => {
    expect(() => daysBetween("2026-01-01T00:00:00", "2026-01-02T00:00:00Z")).toThrow(RangeError);
  });

  it("confidenceFromSampleSize rejects NaN or negative sample sizes instead of labeling them thin", () => {
    expect(() => confidenceFromSampleSize(Number.NaN, { high: 8, moderate: 3 })).toThrow(RangeError);
    expect(() => confidenceFromSampleSize(-1, { high: 8, moderate: 3 })).toThrow(RangeError);
  });

  it("confidenceFromSampleSize rejects malformed thresholds", () => {
    expect(() => confidenceFromSampleSize(1, { high: 3, moderate: 8 })).toThrow(RangeError);
    expect(() => confidenceFromSampleSize(1, null as never)).toThrow(TypeError);
  });
});
