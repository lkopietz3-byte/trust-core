import { describe, expect, it } from "vitest";
import {
  assessAuthenticity,
  resolveAnonymousConfig,
  type AnonymousConfig,
  type AnonymousSignal,
  type AuthenticityAssessment,
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

const NOW = "2026-08-01T00:00:00Z";
const FRESH = "2026-07-25T00:00:00Z";

const config: AnonymousConfig = resolveAnonymousConfig({
  sourceWeights: { forum: 0.85, blog: 0.6, marketplace: 0.5, aggregator: 0.4, muted: 0 },
  confidence: { high: 4, moderate: 2 },
});
const CREDIBLE = ["forum", "blog", "marketplace", "aggregator"] as const;

let counter = 0;
function sig(source: string, sentiment: number, overrides: Partial<AnonymousSignal> = {}): AnonymousSignal {
  counter += 1;
  return { id: `s${counter}`, source, sentiment, confidence: 0.9, publishedAt: FRESH, ...overrides };
}
const assess = (signals: AnonymousSignal[], cfg: AnonymousConfig = config): AuthenticityAssessment =>
  assessAuthenticity(signals, cfg, { now: NOW });

const INSUFFICIENT_REASON =
  "no observation has a positive effective weight (confidence, source credibility and recency decay must all be above 0)";
const INSUFFICIENT_TEXT = `Insufficient evidence: ${INSUFFICIENT_REASON}, so no score is reported.`;

describe("no eligible evidence is an explicit 'insufficient' result (TC-003)", () => {
  const expected = (signalCount: number) => ({
    // null, not 0: 0 would read as "measured as least trustworthy" and sort
    // an entity with no evidence below one that looks planted.
    trustScore: null,
    components: { consensus: 0, diversity: 0, volume: 0, recency: 0, astroturfPenalty: 0 },
    sourceCount: 0,
    signalCount,
    eligibleSignalCount: 0,
    flags: { lowSourceCount: false, uniformSentiment: false },
    confidence: {
      level: "insufficient",
      effectiveSampleSize: 0,
      reason: INSUFFICIENT_REASON,
    },
    explanation: INSUFFICIENT_TEXT,
  });

  it("no observations at all", () => {
    expect(assess([])).toEqual(expected(0));
  });

  it("six configured source types, every one with confidence 0 (audit R01: this used to be 60/100 with high confidence)", () => {
    const signals = ["forum", "blog", "marketplace", "aggregator", "forum", "blog"].map((s) =>
      sig(s, 0.2, { confidence: 0 }),
    );
    expect(assess(signals)).toEqual(expected(6));
  });

  it("six unclassified source labels with full confidence (audit R02: this used to be 75/100 with high confidence)", () => {
    const signals = ["a", "b", "c", "d", "e", "f"].map((s) => sig(s, 0.2, { confidence: 1 }));
    expect(assess(signals)).toEqual(expected(6));
  });

  it("a source explicitly configured with credibility 0 is ineligible too", () => {
    expect(assess([sig("muted", 0.9), sig("muted", 0.9), sig("muted", 0.9)])).toEqual(expected(3));
  });

  it("zero thresholds cannot turn no evidence into 'high' confidence", () => {
    const zero = resolveAnonymousConfig({ ...config, confidence: { high: 0, moderate: 0 } });
    expect(assess([sig("forum", 0.5, { confidence: 0 })], zero).confidence.level).toBe("insufficient");
    expect(assess([], zero).confidence.level).toBe("insufficient");
  });

  it("an empty corpus is not scored as a uniform or concentrated one even when minSignalsForUniformCheck is 0", () => {
    const strict = resolveAnonymousConfig({
      ...config,
      astroturf: { ...config.astroturf, minSignalsForUniformCheck: 0 },
    });
    const result = assess([], strict);
    expect(result.flags).toEqual({ lowSourceCount: false, uniformSentiment: false });
    expect(result.components.astroturfPenalty).toBe(0);
  });

  it("invalid ineligible observations are still rejected: 'contributes nothing' is not 'is not validated'", () => {
    expect(() => assess([sig("forum", 5, { confidence: 0 })])).toThrow(RangeError);
    expect(() => assess([sig("unknown", 0.1, { publishedAt: "yesterday" })])).toThrow(RangeError);
    expect(() => assess([sig("muted", 0.1, { confidence: 2 })])).toThrow(RangeError);
  });

  it("one eligible observation ends the insufficient outcome, with its own counts", () => {
    const result = assess([sig("forum", 0.5), sig("unknown", 0.9), sig("blog", 0.9, { confidence: 0 })]);
    expect(result.confidence.level).toBe("thin");
    expect(result.confidence.reason).toBeUndefined();
    expect(result.confidence.effectiveSampleSize).toBe(1);
    expect(result.sourceCount).toBe(1);
    expect(result.signalCount).toBe(3);
    expect(result.eligibleSignalCount).toBe(1);
  });
});

describe("ineligible observations are ignored by every component", () => {
  const eligible = [sig("forum", 0.9), sig("blog", 0.95), sig("marketplace", 0.9), sig("aggregator", 0.95)];

  it("their sentiment does not enter the uniformity mean or variance", () => {
    const withNoise = [...eligible, sig("forum", -1, { confidence: 0 }), sig("unknown", -1), sig("muted", -1)];
    const result = assess(withNoise);
    expect(result.flags.uniformSentiment).toBe(assess(eligible).flags.uniformSentiment);
    expect(result).toEqual({ ...assess(eligible), signalCount: 7 });
  });

  it("they do not count toward the minimum signal count of the uniformity check", () => {
    const strict = resolveAnonymousConfig({
      ...config,
      astroturf: { ...config.astroturf, minSignalsForUniformCheck: 3 },
    });
    const two = [sig("forum", 0.97), sig("forum", 0.97)];
    const padded = [...two, sig("forum", 0.97, { confidence: 0 }), sig("unknown", 0.97), sig("muted", 0.97)];
    expect(assess(padded, strict).flags).toEqual({ lowSourceCount: false, uniformSentiment: false });
    expect(assess(padded, strict)).toEqual({ ...assess(two, strict), signalCount: 5 });
  });

  it("they do not add to source diversity, volume or the source count", () => {
    const base = [sig("forum", 0.4), sig("blog", 0.2)];
    const padded = [...base, sig("unknown-1", 0.4), sig("unknown-2", 0.4), sig("marketplace", 0.4, { confidence: 0 })];
    const result = assess(padded);
    expect(result.sourceCount).toBe(2);
    expect(result.components.diversity).toBe(assess(base).components.diversity);
    expect(result.components.volume).toBe(assess(base).components.volume);
  });

  it("a stale ineligible observation does not drag the recency component down", () => {
    const base = [sig("forum", 0.4), sig("blog", 0.2)];
    const padded = [...base, sig("unknown", 0.4, { confidence: 1, publishedAt: "2000-01-01" })];
    expect(assess(padded).components.recency).toBe(assess(base).components.recency);
  });
});

describe("property: ineligible observations contribute nothing (seeded)", () => {
  const rand = mulberry32(20260928);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  const randomEligible = (): AnonymousSignal =>
    sig(pick(CREDIBLE), rand() * 2 - 1, {
      confidence: 0.05 + rand() * 0.95,
      publishedAt: rand() < 0.2 ? null : `202${Math.floor(rand() * 6)}-0${1 + Math.floor(rand() * 9)}-15T00:00:00Z`,
    });
  const randomIneligible = (): AnonymousSignal => {
    const publishedAt = rand() < 0.5 ? null : `20${10 + Math.floor(rand() * 16)}-0${1 + Math.floor(rand() * 9)}-15T00:00:00Z`;
    const sentiment = rand() * 2 - 1;
    switch (Math.floor(rand() * 3)) {
      case 0:
        return sig(pick(CREDIBLE), sentiment, { confidence: 0, publishedAt });
      case 1:
        return sig(rand() < 0.5 ? "muted" : `unclassified-${Math.floor(rand() * 5)}`, sentiment, { confidence: rand(), publishedAt });
      default:
        return sig("muted", sentiment, { confidence: 0, publishedAt });
    }
  };
  const shuffle = <T>(items: T[]): T[] => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
    }
    return copy;
  };

  it("adding ineligible observations, anywhere, changes no output except the submitted count", () => {
    for (let trial = 0; trial < 300; trial++) {
      const base = Array.from({ length: Math.floor(rand() * 10) }, randomEligible);
      const extra = Array.from({ length: 1 + Math.floor(rand() * 5) }, randomIneligible);
      const before = assess(base);
      const after = assess(shuffle([...base, ...extra]));
      expect(after).toEqual({ ...before, signalCount: before.signalCount + extra.length });
    }
  });

  it("the effective sample size is the number of distinct eligible source types, and eligibleSignalCount is the number of eligible observations", () => {
    for (let trial = 0; trial < 300; trial++) {
      const eligible = Array.from({ length: Math.floor(rand() * 10) }, randomEligible);
      const all = shuffle([...eligible, ...Array.from({ length: Math.floor(rand() * 4) }, randomIneligible)]);
      const result = assess(all);
      const distinct = new Set(eligible.map((s) => s.source)).size;
      expect(result.confidence.effectiveSampleSize).toBe(distinct);
      expect(result.sourceCount).toBe(distinct);
      expect(result.eligibleSignalCount).toBe(eligible.length);
      expect(result.signalCount).toBe(all.length);
      expect(result.confidence.level === "insufficient").toBe(eligible.length === 0);
    }
  });

  it("with unit credibility and confidence every observation is eligible, so the counts equal the input", () => {
    const unitConfig = resolveAnonymousConfig({ sourceWeights: { a: 1, b: 1, c: 1 } });
    for (let trial = 0; trial < 100; trial++) {
      const signals = Array.from({ length: 1 + Math.floor(rand() * 10) }, () =>
        sig(pick(["a", "b", "c"]), rand() * 2 - 1, { confidence: 1 }),
      );
      const result = assess(signals, unitConfig);
      expect(result.eligibleSignalCount).toBe(signals.length);
      expect(result.confidence.effectiveSampleSize).toBe(new Set(signals.map((s) => s.source)).size);
    }
  });
});

describe("explanations describe patterns and uncertainty only (TC-004)", () => {
  const BANNED = /planted|fraud|fake|fabricat|astroturf|suspicious|manipulat|\bindependent\b|\bgenuine\b|\bauthentic/i;
  const varied = [sig("forum", 0.6), sig("blog", 0.2), sig("marketplace", 0.4)];

  it("the base sentence calls the sources distinct types and says independence is not verified", () => {
    expect(assess(varied).explanation).toMatch(
      /^Heuristic score \d+\/100 from 3 distinct source types \(independence not verified\)\./,
    );
    expect(assess([sig("forum", 0.6), sig("forum", 0.5)]).explanation).toContain("from 1 distinct source type (independence");
  });

  it("uniform near-maximal sentiment is described as a pattern in the numbers, never as planted or fabricated", () => {
    const uniform = CREDIBLE.map((source) => sig(source, 0.95));
    const { explanation, flags } = assess(uniform);
    expect(flags.uniformSentiment).toBe(true);
    expect(explanation).toContain(
      "Sentiment is unusually uniform, which lowers the score. This is a pattern in the numbers, not a finding about the observations.",
    );
    expect(explanation).not.toMatch(BANNED);
  });

  it("concentration in few source types is described without claiming independence", () => {
    const concentrated = [sig("forum", 0.5), sig("forum", 0.4), sig("forum", 0.6)];
    const { explanation, flags } = assess(concentrated);
    expect(flags.lowSourceCount).toBe(true);
    expect(explanation).toContain("Evidence comes from very few distinct source types, which lowers the score.");
    expect(explanation).not.toMatch(BANNED);
  });

  it("low diversity says so in terms of source types and uncertainty", () => {
    const repeated = Array.from({ length: 6 }, () => sig("forum", 0.5));
    expect(assess(repeated).explanation).toContain(
      "Few distinct source types relative to the number of observations; treat as uncertain.",
    );
  });

  it("stale dated evidence is described from the supplied dates", () => {
    const old = [sig("forum", 0.5, { publishedAt: "2019-01-01" }), sig("blog", 0.5, { publishedAt: "2019-06-01" }), sig("marketplace", 0.5)];
    expect(assess(old).explanation).toContain(
      "Recency is low given the publication dates supplied; observations without a date use the configured default age.",
    );
  });

  it("with no publication dates it says recency is only the configured default, and never asserts the evidence is dated", () => {
    const undated = [sig("forum", 0.5, { publishedAt: null }), sig("blog", 0.5, { publishedAt: undefined })];
    const old = resolveAnonymousConfig({ ...config, recency: { halfLifeDays: 30, missingDateAgeDays: 400 } });
    const { explanation } = assess(undated, old);
    expect(explanation).toContain(
      "No publication dates were supplied, so recency reflects only the configured default age and is uncertain.",
    );
    expect(explanation).not.toMatch(/dated|old/);
  });

  it("recent evidence gets no recency sentence", () => {
    expect(assess(varied).explanation).not.toMatch(/[Rr]ecency|publication dates/);
  });

  it("keeps the sentiment sentences", () => {
    expect(assess([sig("forum", 0.9), sig("blog", 0.9), sig("marketplace", 0.9)]).explanation).toContain("Sentiment is strongly positive.");
    expect(assess([sig("forum", -0.5), sig("blog", -0.5), sig("marketplace", -0.5)]).explanation).toContain(
      "Sentiment is lukewarm or negative.",
    );
    expect(assess([sig("forum", 0.1), sig("blog", 0.1), sig("marketplace", 0.1)]).explanation).not.toMatch(/Sentiment is/);
  });

  it("no explanation, over random corpora, contains a banned claim word", () => {
    const rand = mulberry32(42);
    for (let trial = 0; trial < 300; trial++) {
      const signals = Array.from({ length: Math.floor(rand() * 9) }, () =>
        sig(["forum", "blog", "marketplace", "aggregator", "muted", "other"][Math.floor(rand() * 6)] as string, rand() < 0.5 ? 0.97 : rand() * 2 - 1, {
          confidence: rand() < 0.2 ? 0 : rand(),
          publishedAt: rand() < 0.3 ? null : `20${15 + Math.floor(rand() * 11)}-06-01`,
        }),
      );
      expect(assess(signals).explanation).not.toMatch(BANNED);
    }
  });
});

describe("a fully decayed observation is not eligible (effective weight decides)", () => {
  const SOURCES = ["forum", "blog", "marketplace", "aggregator"] as const;
  const ANCIENT = "0001-01-01";
  const instant = resolveAnonymousConfig({ ...config, recency: { halfLifeDays: 0, missingDateAgeDays: 540 } });
  const slow = resolveAnonymousConfig({ ...config, recency: { halfLifeDays: 7, missingDateAgeDays: 540 } });
  const dayOld = "2026-07-31";

  it("halfLifeDays 0 with dated evidence is insufficient, not a neutral score from 'eligible' zero-weight rows", () => {
    const negatives = SOURCES.map((source) => sig(source, -1, { confidence: 1, publishedAt: dayOld }));
    const result = assess(negatives, instant);
    expect(result.trustScore).toBeNull();
    expect(result.confidence).toEqual({ level: "insufficient", effectiveSampleSize: 0, reason: INSUFFICIENT_REASON });
    expect(result.sourceCount).toBe(0);
    expect(result.eligibleSignalCount).toBe(0);
    expect(result.signalCount).toBe(4);
    expect(result.explanation).toBe(`Insufficient evidence: ${INSUFFICIENT_REASON}, so no score is reported.`);
  });

  it("decades-old evidence whose weight underflows to exactly 0 is insufficient", () => {
    for (const publishedAt of ["2001-01-01", ANCIENT]) {
      const result = assess(SOURCES.map((source) => sig(source, -1, { confidence: 1, publishedAt })), slow);
      expect(result.trustScore).toBeNull();
      expect(result.confidence.level).toBe("insufficient");
      expect(result.eligibleSignalCount).toBe(0);
    }
  });

  it("an all-negative and an all-positive corpus of fully decayed evidence are the same 'insufficient' result, so neither outranks the other", () => {
    const build = (sentiment: number) => SOURCES.map((source) => sig(source, sentiment, { confidence: 1, publishedAt: ANCIENT }));
    const negative = assess(build(-1), slow);
    const positive = assess(build(1), slow);
    expect(negative).toEqual(positive);
    expect(negative.trustScore).toBeNull();
  });

  it("a live observation keeps counting when a fully decayed one sits beside it", () => {
    const live = sig("forum", 0.5, { confidence: 1, publishedAt: NOW });
    const dead = sig("blog", -1, { confidence: 1, publishedAt: dayOld });
    const result = assess([live, dead], instant);
    expect(result.eligibleSignalCount).toBe(1);
    expect(result.sourceCount).toBe(1);
    expect(result.signalCount).toBe(2);
    expect(result.confidence.effectiveSampleSize).toBe(1);
    expect(result.components.consensus).toBe(0.75);
    expect(result.components.recency).toBe(1);
  });

  it("the boundary: an observation at age 0 has weight and counts; one day older with halfLifeDays 0 does not", () => {
    expect(assess([sig("forum", 0.5, { confidence: 1, publishedAt: NOW })], instant).eligibleSignalCount).toBe(1);
    expect(assess([sig("forum", 0.5, { confidence: 1, publishedAt: dayOld })], instant).eligibleSignalCount).toBe(0);
  });

  it("an undated observation decayed to 0 by missingDateAgeDays is ineligible too", () => {
    const undatedStale = resolveAnonymousConfig({ ...config, recency: { halfLifeDays: 0, missingDateAgeDays: 1 } });
    expect(assess([sig("forum", 0.5, { publishedAt: null })], undatedStale).trustScore).toBeNull();
  });

  describe("properties (seeded)", () => {
    const rand = mulberry32(20260930);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
    const recencyOptions = [
      { halfLifeDays: 30, missingDateAgeDays: 400 },
      { halfLifeDays: 7, missingDateAgeDays: 540 },
      { halfLifeDays: 0, missingDateAgeDays: 540 },
      { halfLifeDays: Infinity, missingDateAgeDays: 0 },
    ];
    const randomAge = (): string | null => {
      const r = rand();
      if (r < 0.15) return null;
      if (r < 0.3) return ANCIENT;
      if (r < 0.45) return "2001-01-01";
      return `2026-0${1 + Math.floor(rand() * 7)}-${10 + Math.floor(rand() * 18)}T00:00:00Z`;
    };
    const randomSignal = (): AnonymousSignal =>
      sig(pick(SOURCES), 0.05 + rand() * 0.95, { confidence: 0.05 + rand() * 0.95, publishedAt: randomAge() });

    it("adding a fully decayed observation, anywhere, changes no output except the submitted count", () => {
      for (let trial = 0; trial < 300; trial++) {
        const cfg = resolveAnonymousConfig({ ...config, recency: pick(recencyOptions) });
        // Decayed to exactly 0: ancient under any finite half-life, or one day old under halfLifeDays 0.
        const decayed = (): AnonymousSignal => {
          const base = sig(pick(SOURCES), rand() * 2 - 1, { confidence: 0.05 + rand() * 0.95 });
          if (cfg.recency.halfLifeDays === Infinity) return { ...base, confidence: 0 };
          return { ...base, publishedAt: cfg.recency.halfLifeDays === 0 ? dayOld : ANCIENT };
        };
        const base = Array.from({ length: Math.floor(rand() * 8) }, randomSignal);
        const extra = Array.from({ length: 1 + Math.floor(rand() * 4) }, decayed);
        const merged = [...base];
        for (const signal of extra) merged.splice(Math.floor(rand() * (merged.length + 1)), 0, signal);
        const before = assess(base, cfg);
        const after = assess(merged, cfg);
        expect(after).toEqual({ ...before, signalCount: before.signalCount + extra.length });
      }
    });

    it("an all-negative corpus never outranks the all-positive one even when every observation is fully decayed and near-uniform", () => {
      for (let trial = 0; trial < 300; trial++) {
        const cfg = resolveAnonymousConfig({ ...config, recency: pick(recencyOptions.filter((r) => r.halfLifeDays !== Infinity)) });
        const when = cfg.recency.halfLifeDays === 0 ? dayOld : ANCIENT;
        const positive = Array.from({ length: 3 + Math.floor(rand() * 4) }, () =>
          sig(pick(SOURCES), 0.9 + rand() * 0.1, { confidence: 0.5 + rand() * 0.5, publishedAt: when }),
        );
        const negative = positive.map((s) => ({ ...s, sentiment: -s.sentiment }));
        const up = assess(positive, cfg);
        const down = assess(negative, cfg);
        expect(down).toEqual(up);
        expect(up.trustScore).toBeNull();
      }
    });

    it("an all-negative corpus never outranks the same corpus made all-positive", () => {
      for (let trial = 0; trial < 300; trial++) {
        const cfg = resolveAnonymousConfig({ ...config, recency: pick(recencyOptions) });
        const positive = Array.from({ length: Math.floor(rand() * 9) }, randomSignal);
        const negative = positive.map((s) => ({ ...s, sentiment: -s.sentiment }));
        const up = assess(positive, cfg);
        const down = assess(negative, cfg);
        // Eligibility depends on weight only, so both are scored or neither is.
        expect(up.trustScore === null).toBe(down.trustScore === null);
        expect(up.eligibleSignalCount).toBe(down.eligibleSignalCount);
        if (up.trustScore !== null && down.trustScore !== null) {
          expect(down.trustScore).toBeLessThanOrEqual(up.trustScore);
        }
      }
    });
  });
});
