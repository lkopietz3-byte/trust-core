import { describe, expect, it } from "vitest";
import {
  resolveIdentifiedConfig,
  scoreEntity,
  type IdentifiedConfig,
  type IdentifiedSignal,
  type SignalContribution,
} from "./index.js";
import { confidenceFromSampleSize, shrinkTowardPrior } from "../shared/types.js";

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

const NOW = "2026-08-01T00:00:00Z";

/** Every factor is 1 except `off` (weight 0): a signal's weight is 1 when on, 0 when off. */
const UNIT: IdentifiedConfig = resolveIdentifiedConfig({
  tierWeights: { on: 1, off: 0 },
  sourceWeights: { s: 1 },
  proofWeights: { p: 1 },
  reputation: { floor: 1, ceil: 1, neutral: 1 },
  recency: { halfLifeDays: Infinity, missingDateAgeDays: 0 },
  confidence: { high: 5, moderate: 2 },
});

let counter = 0;
function unit(tier: "on" | "off", value: number, overrides: Partial<IdentifiedSignal> = {}): IdentifiedSignal {
  counter += 1;
  return { id: `u${counter}`, tier, source: "s", proof: "p", reputation: null, occurredAt: NOW, value, ...overrides };
}

describe("no eligible evidence is an explicit 'insufficient' result (TC-003)", () => {
  it("empty input: confidence is insufficient, raw is null, and the score is exactly the prior", () => {
    const result = scoreEntity([], UNIT, { now: NOW, prior: 61.7, dial: 3 });
    expect(result.confidence.level).toBe("insufficient");
    expect(result.confidence.effectiveSampleSize).toBe(0);
    expect(result.confidence.reason).toBe("no signal has a positive weight, so the score is the prior");
    expect(result.raw).toBeNull();
    expect(result.score).toBe(61.7);
    expect(result.nEff).toBe(0);
    expect(result.signalCount).toBe(0);
    expect(result.eligibleSignalCount).toBe(0);
  });

  it("all signals zero-weight: same outcome, with the submitted count kept apart from the eligible count", () => {
    const result = scoreEntity([unit("off", 100), unit("off", 0)], UNIT, { now: NOW, prior: 0.1, dial: 3 });
    expect(result.confidence.level).toBe("insufficient");
    expect(result.confidence.reason).toBe("no signal has a positive weight, so the score is the prior");
    expect(result.raw).toBeNull();
    expect(result.score).toBe(0.1);
    expect(result.nEff).toBe(0);
    expect(result.signalCount).toBe(2);
    expect(result.eligibleSignalCount).toBe(0);
    expect(result.contributions.map((c) => c.weight)).toEqual([0, 0]);
  });

  it("zero thresholds cannot turn no evidence into 'high' or 'moderate' confidence", () => {
    const zero = resolveIdentifiedConfig({ ...UNIT, confidence: { high: 0, moderate: 0 } });
    expect(scoreEntity([], zero, { now: NOW, prior: 50 }).confidence.level).toBe("insufficient");
    expect(scoreEntity([unit("off", 90)], zero, { now: NOW, prior: 50 }).confidence.level).toBe("insufficient");
  });

  it("a positive but tiny sample size is 'thin', not insufficient", () => {
    expect(confidenceFromSampleSize(1e-300, { high: 8, moderate: 3 }).level).toBe("thin");
    expect(confidenceFromSampleSize(0, { high: 8, moderate: 3 })).toEqual({
      level: "insufficient",
      effectiveSampleSize: 0,
      reason: "no evidence carried any weight (effective sample size is 0)",
    });
  });

  it("shrinkTowardPrior returns the prior exactly, bit for bit, when totalWeight is 0", () => {
    for (const [dial, prior] of [[3, 0.1], [3, 61.7], [6, 12.7], [0.5, 33.3], [0, 55]] as const) {
      expect(shrinkTowardPrior(0, 0, prior, dial)).toBe(prior);
    }
  });

  it("a single positive-weight signal still moves the score off the prior", () => {
    const result = scoreEntity([unit("on", 100)], UNIT, { now: NOW, prior: 0, dial: 1 });
    expect(result.confidence.level).toBe("thin");
    expect(result.eligibleSignalCount).toBe(1);
    expect(result.confidence.reason).toBeUndefined();
    expect(result.score).toBe(50);
  });
});

describe("property: zero-weight signals contribute nothing (seeded)", () => {
  const rand = mulberry32(20260928);
  const randomOn = (): IdentifiedSignal => unit("on", Math.floor(rand() * 101), { occurredAt: rand() < 0.3 ? null : NOW });
  const randomOff = (): IdentifiedSignal =>
    unit("off", Math.floor(rand() * 101), {
      reputation: rand() < 0.5 ? null : Math.floor(rand() * 101),
      occurredAt: rand() < 0.5 ? null : "2020-01-01",
    });
  const withoutZeroWeight = (contributions: SignalContribution[]): SignalContribution[] =>
    contributions.filter((c) => c.weight > 0);

  it("adding any number of zero-weight signals, anywhere, changes no output except the submitted count and their own rows", () => {
    for (let trial = 0; trial < 200; trial++) {
      const base = Array.from({ length: Math.floor(rand() * 8) }, randomOn);
      const extra = Array.from({ length: 1 + Math.floor(rand() * 4) }, randomOff);
      const merged = [...base];
      for (const signal of extra) merged.splice(Math.floor(rand() * (merged.length + 1)), 0, signal);
      const options = { now: NOW, prior: Math.floor(rand() * 101), dial: rand() * 10 };

      const before = scoreEntity(base, UNIT, options);
      const after = scoreEntity(merged, UNIT, options);

      expect(after.score).toBe(before.score);
      expect(after.raw).toBe(before.raw);
      expect(after.nEff).toBe(before.nEff);
      expect(after.prior).toBe(before.prior);
      expect(after.confidence).toEqual(before.confidence);
      expect(after.eligibleSignalCount).toBe(before.eligibleSignalCount);
      expect(withoutZeroWeight(after.contributions)).toEqual(withoutZeroWeight(before.contributions));
      expect(after.signalCount).toBe(before.signalCount + extra.length);
    }
  });

  it("under unit weights nEff equals the number of eligible signals, and raw is their plain mean", () => {
    for (let trial = 0; trial < 200; trial++) {
      const signals: IdentifiedSignal[] = [];
      let eligible = 0;
      let total = 0;
      for (let i = 0; i < Math.floor(rand() * 12); i++) {
        const on = rand() < 0.6;
        const value = Math.floor(rand() * 101);
        signals.push(unit(on ? "on" : "off", value));
        if (on) {
          eligible += 1;
          total += value;
        }
      }
      const result = scoreEntity(signals, UNIT, { now: NOW, prior: 50, dial: 2 });
      expect(result.nEff).toBe(eligible);
      expect(result.eligibleSignalCount).toBe(eligible);
      expect(result.signalCount).toBe(signals.length);
      if (eligible === 0) {
        expect(result.raw).toBeNull();
        expect(result.confidence.level).toBe("insufficient");
      } else {
        expect(result.raw).toBeCloseTo(total / eligible, 9);
        expect(result.confidence.level).not.toBe("insufficient");
      }
    }
  });
});

describe("equal-weight contributions have a stable order (TC-006)", () => {
  const mk = (id: string, overrides: Partial<IdentifiedSignal> = {}): IdentifiedSignal =>
    unit("on", 50, { id, ...overrides });
  const order = (signals: IdentifiedSignal[]): string[] =>
    scoreEntity(signals, UNIT, { now: NOW, prior: 50 }).contributions.map((c) => c.id);

  it("ties are broken by id, ascending, whatever the input order (audit R11)", () => {
    expect(order([mk("b"), mk("a")])).toEqual(["a", "b"]);
    expect(order([mk("a"), mk("b")])).toEqual(["a", "b"]);
  });

  it("compares ids by UTF-16 code unit, independent of locale", () => {
    expect(order([mk("a"), mk("B"), mk("_")])).toEqual(["B", "_", "a"]);
  });

  it("a heavier signal still comes first regardless of id", () => {
    const heavy = resolveIdentifiedConfig({ ...UNIT, tierWeights: { on: 1, off: 0, heavy: 2 } });
    const result = scoreEntity([mk("a"), unit("on", 50, { id: "z", tier: "heavy" })], heavy, { now: NOW, prior: 50 });
    expect(result.contributions.map((c) => c.id)).toEqual(["z", "a"]);
  });

  it("the whole result is identical under every permutation, even with duplicate ids and null ages", () => {
    const rand = mulberry32(6);
    const multi = resolveIdentifiedConfig({
      ...UNIT,
      tierWeights: { on: 1, off: 0, twin: 1 },
      sourceWeights: { s: 1, t: 1 },
      proofWeights: { p: 1, q: 1 },
    });
    for (let trial = 0; trial < 100; trial++) {
      const signals: IdentifiedSignal[] = [
        mk("dup"),
        mk("dup", { tier: "twin" }),
        mk("dup", { source: "t" }),
        mk("dup", { proof: "q" }),
        mk("dup", { occurredAt: null }),
        mk("dup", { occurredAt: "2026-07-01" }),
        mk("dup", { occurredAt: "2026-06-01" }),
        mk("other"),
      ];
      const shuffled = [...signals];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j] as IdentifiedSignal, shuffled[i] as IdentifiedSignal];
      }
      const options = { now: NOW, prior: 50 };
      expect(scoreEntity(shuffled, multi, options)).toEqual(scoreEntity(signals, multi, options));
    }
  });

  it("orders otherwise identical contributions by age, youngest first and unknown age last, from every input order", () => {
    const ages: (string | null)[] = [NOW, "2026-07-27", "2026-07-01", null];
    const permutations = (items: (string | null)[]): (string | null)[][] =>
      items.length <= 1
        ? [items]
        : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
    for (const permutation of permutations(ages)) {
      const rows = scoreEntity(
        permutation.map((occurredAt) => mk("same", { occurredAt })),
        UNIT,
        { now: NOW, prior: 50 },
      ).contributions.map((c) => c.ageDays);
      expect(rows).toEqual([0, 5, 31, null]);
    }
  });

  it("keeps two fully identical contributions, in either order", () => {
    const result = scoreEntity([mk("same"), mk("same")], UNIT, { now: NOW, prior: 50 });
    expect(result.contributions).toHaveLength(2);
    expect(result.contributions[0]).toEqual(result.contributions[1]);
  });

  it("orders the tie-break keys id, tier, source, proof, then age with unknown age last", () => {
    const multi = resolveIdentifiedConfig({
      ...UNIT,
      tierWeights: { on: 1, off: 0, twin: 1 },
      sourceWeights: { s: 1, t: 1 },
      proofWeights: { p: 1, q: 1 },
    });
    const rows = scoreEntity(
      [
        mk("a", { occurredAt: null }),
        mk("a", { occurredAt: "2026-07-01" }),
        mk("a", { proof: "q" }),
        mk("a", { source: "t" }),
        mk("a", { tier: "twin" }),
        mk("a"),
      ],
      multi,
      { now: NOW, prior: 50 },
    ).contributions.map((c) => `${c.tier}/${c.source}/${c.proof}/${c.ageDays}`);
    expect(rows).toEqual([
      "on/s/p/0",
      "on/s/p/31",
      "on/s/p/null",
      "on/s/q/0",
      "on/t/p/0",
      "twin/s/p/0",
    ]);
  });
});

describe("a fully decayed signal carries no weight (same rule as anonymous eligibility)", () => {
  const instant = resolveIdentifiedConfig({ ...UNIT, recency: { halfLifeDays: 0, missingDateAgeDays: 0 } });
  const slow = resolveIdentifiedConfig({ ...UNIT, recency: { halfLifeDays: 7, missingDateAgeDays: 0 } });

  it("only fully decayed signals: insufficient evidence, raw null, score exactly the prior", () => {
    for (const [cfg, occurredAt] of [
      [instant, "2026-07-31"],
      [slow, "0001-01-01"],
    ] as const) {
      const result = scoreEntity([unit("on", 0, { occurredAt }), unit("on", 100, { occurredAt })], cfg, { now: NOW, prior: 42 });
      expect(result.confidence.level).toBe("insufficient");
      expect(result.raw).toBeNull();
      expect(result.score).toBe(42);
      expect(result.nEff).toBe(0);
      expect(result.eligibleSignalCount).toBe(0);
      expect(result.signalCount).toBe(2);
    }
  });

  it("a fully decayed signal beside a live one changes nothing except the submitted count and its own row", () => {
    const live = unit("on", 80, { occurredAt: NOW });
    const before = scoreEntity([live], instant, { now: NOW, prior: 50 });
    const after = scoreEntity([live, unit("on", 0, { occurredAt: "2026-07-31" })], instant, { now: NOW, prior: 50 });
    expect(after.score).toBe(before.score);
    expect(after.raw).toBe(before.raw);
    expect(after.nEff).toBe(before.nEff);
    expect(after.confidence).toEqual(before.confidence);
    expect(after.eligibleSignalCount).toBe(1);
    expect(after.signalCount).toBe(2);
  });
});
