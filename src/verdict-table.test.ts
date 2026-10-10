/**
 * Verdict regression table.
 *
 * Named, realistic review sets with the outcome each one should get: which
 * pattern flags fire, how sets rank against each other, and which confidence
 * label they carry. Every set is scored with the shipped example configs,
 * because downstream tools use those as defaults. Change an expectation here
 * only with a CHANGELOG entry that says why the verdict moved.
 */
import { describe, expect, it } from "vitest";
import {
  assessAuthenticity,
  EXAMPLE_ANONYMOUS_CONFIG,
  resolveAnonymousConfig,
  type AnonymousConfig,
  type AnonymousSignal,
  type AuthenticityAssessment,
} from "./anonymous/index.js";
import {
  composeDimensions,
  composeDimensionsDetailed,
  EXAMPLE_IDENTIFIED_CONFIG,
  resolveIdentifiedConfig,
  scoreEntity,
  type IdentifiedConfig,
  type IdentifiedSignal,
} from "./identified/index.js";

const NOW = "2026-10-01T00:00:00Z";
const NOW_MS = Date.parse(NOW);
const DAY_MS = 24 * 60 * 60 * 1000;
const CONFIG = EXAMPLE_ANONYMOUS_CONFIG;

/** Deterministic PRNG (mulberry32) so the fuzz cases are reproducible. */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An ISO timestamp `days` before NOW. */
const daysAgo = (days: number): string => new Date(NOW_MS - days * DAY_MS).toISOString();
/** A 1-5 star rating mapped onto the [-1, 1] sentiment scale. */
const stars = (n: number): number => (n - 3) / 2;

let counter = 0;
function obs(source: string, sentiment: number, overrides: Partial<AnonymousSignal> = {}): AnonymousSignal {
  counter += 1;
  return { id: `o${counter}`, source, sentiment, confidence: 0.9, publishedAt: daysAgo(20), ...overrides };
}
const assess = (signals: AnonymousSignal[], config: AnonymousConfig = CONFIG): AuthenticityAssessment =>
  assessAuthenticity(signals, config, { now: NOW });
const score = (signals: AnonymousSignal[], config: AnonymousConfig = CONFIG): number => {
  const result = assess(signals, config);
  expect(result.trustScore).not.toBeNull();
  return result.trustScore as number;
};

const FOUR = ["forum", "marketplace", "blog", "community"] as const;
const FIVE = ["forum", "marketplace", "blog", "community", "social"] as const;

/** A set of star ratings spread round-robin over `sources`, with dates spread over `spanDays`. */
function ratings(starList: number[], sources: readonly string[], spanDays: number, confidence = 0.9): AnonymousSignal[] {
  return starList.map((n, i) =>
    obs(sources[i % sources.length] as string, stars(n), {
      confidence,
      publishedAt: daysAgo(Math.round(((i * 7919) % 997) / 997 * spanDays)),
    }),
  );
}
const repeat = (n: number, value: number): number[] => Array.from({ length: n }, () => value);

// ---------------------------------------------------------------------------
// The named sets
// ---------------------------------------------------------------------------

const SETS = {
  /** Three reviews, mostly five stars, from three source types. */
  organicSmall: [
    obs("forum", stars(5), { confidence: 0.9, publishedAt: daysAgo(10) }),
    obs("marketplace", stars(5), { confidence: 0.85, publishedAt: daysAgo(40) }),
    obs("blog", stars(4), { confidence: 0.8, publishedAt: daysAgo(95) }),
  ],
  /** 23 five-star and 2 four-star reviews (4.92 stars) over four source types. */
  enthusiastic492: ratings([...repeat(23, 5), ...repeat(2, 4)], FOUR, 180),
  /** 15 five-star and 10 four-star reviews (4.60 stars), same layout. */
  enthusiastic460: ratings([...repeat(15, 5), ...repeat(10, 4)], FOUR, 180),
  /** A realistic spread of 1-5 star reviews over five source types and a year. */
  mixedHonest: ratings(
    [...repeat(12, 5), ...repeat(6, 4), ...repeat(3, 3), ...repeat(2, 2), 1],
    FIVE,
    365,
    0.85,
  ),
  /** 30 recent posts, all from one source type, with mild spread. */
  singleSourceRing: Array.from({ length: 30 }, (_, i) =>
    obs("forum", 0.7 + 0.01 * (i % 10), { publishedAt: daysAgo(i) }),
  ),
  /** 20 identical maximal ratings over four source types within two weeks. */
  uniformBot: Array.from({ length: 20 }, (_, i) => obs(FOUR[i % 4] as string, 1, { publishedAt: daysAgo(i % 14) })),
  /** 20 identical minimal ratings over four source types: a review bomb. */
  reviewBomb: Array.from({ length: 20 }, (_, i) => obs(FOUR[i % 4] as string, -1, { publishedAt: daysAgo(i % 14) })),
};

/** The ring plus one near-weightless second source type (confidence 0.001, dated 2016). */
const ringWithDecoy = [
  ...SETS.singleSourceRing,
  obs("aggregator", 0.7, { confidence: 0.001, publishedAt: "2016-01-01T00:00:00Z" }),
];
/** The uniform bot set plus three near-weightless dissenting observations. */
const botWithWeightlessDissent = [
  ...SETS.uniformBot,
  ...[0, 1, 2].map((i) => obs(FOUR[i] as string, -1, { confidence: 0.001 })),
];

const forumReviews = (n: number): AnonymousSignal[] =>
  Array.from({ length: n }, (_, i) => obs("forum", 0.8, { publishedAt: daysAgo(30) , id: `forum-${i}` }));
const thirtyOverThree = Array.from({ length: 30 }, (_, i) =>
  obs(["forum", "blog", "marketplace"][i % 3] as string, 0.8, { publishedAt: daysAgo(30) }),
);

describe("verdict table: anonymous mode on the example config", () => {
  const r = Object.fromEntries(Object.entries(SETS).map(([name, set]) => [name, assess(set)])) as Record<
    keyof typeof SETS,
    AuthenticityAssessment
  >;

  it("organic small 5-star set: no pattern flag, moderate confidence (three source types)", () => {
    expect(r.organicSmall.flags).toEqual({ lowSourceCount: false, uniformSentiment: false });
    expect(r.organicSmall.confidence.level).toBe("moderate");
  });

  it("organic large enthusiastic set: 4.92 stars never ranks below 4.60 stars", () => {
    expect(r.enthusiastic492.flags.lowSourceCount).toBe(false);
    expect(r.enthusiastic460.flags).toEqual({ lowSourceCount: false, uniformSentiment: false });
    expect(r.enthusiastic492.trustScore as number).toBeGreaterThanOrEqual(r.enthusiastic460.trustScore as number);
    expect(r.enthusiastic492.confidence.level).toBe("moderate");
  });

  it("mixed honest set: no pattern flag, outranks the ring, the bot set and the bomb", () => {
    expect(r.mixedHonest.flags).toEqual({ lowSourceCount: false, uniformSentiment: false });
    expect(r.mixedHonest.confidence.level).toBe("moderate");
    expect(r.mixedHonest.trustScore as number).toBeGreaterThan(r.singleSourceRing.trustScore as number);
    expect(r.mixedHonest.trustScore as number).toBeGreaterThan(r.uniformBot.trustScore as number);
    expect(r.mixedHonest.trustScore as number).toBeGreaterThan(r.reviewBomb.trustScore as number);
  });

  it("single-source ring: concentration flag, thin confidence", () => {
    expect(r.singleSourceRing.flags).toEqual({ lowSourceCount: true, uniformSentiment: false });
    expect(r.singleSourceRing.sourceCount).toBe(1);
    expect(r.singleSourceRing.confidence.level).toBe("thin");
  });

  it("uniform bot set: uniformity flag, ranks below the organic enthusiastic set", () => {
    expect(r.uniformBot.flags).toEqual({ lowSourceCount: false, uniformSentiment: true });
    expect(r.uniformBot.confidence.level).toBe("moderate");
    expect(r.uniformBot.trustScore as number).toBeLessThan(r.enthusiastic492.trustScore as number);
  });

  it("review bomb: no pattern flag (the checks look for praise), ranks below every unflagged positive set", () => {
    // A discounted positive set (the ring) can rank below the bomb: trustScore
    // blends sentiment with the pattern discounts, so it is not a sentiment
    // ranking. That is documented in the README's Honest limits.
    expect(r.reviewBomb.flags).toEqual({ lowSourceCount: false, uniformSentiment: false });
    expect(r.reviewBomb.confidence.level).toBe("moderate");
    for (const name of ["organicSmall", "enthusiastic492", "enthusiastic460", "mixedHonest", "uniformBot"] as const) {
      expect(r.reviewBomb.trustScore as number).toBeLessThan(r[name].trustScore as number);
    }
  });

  it("a near-zero-weight decoy source does not lift the ring out of the concentration discount", () => {
    const decoyed = assess(ringWithDecoy);
    expect(decoyed.flags.lowSourceCount).toBe(true);
    expect(decoyed.sourceCount).toBe(1);
    expect(decoyed.confidence.level).toBe("thin");
    expect(Math.abs((decoyed.trustScore as number) - (r.singleSourceRing.trustScore as number))).toBeLessThanOrEqual(1);
  });

  it("near-zero-weight dissent does not lift the bot set out of the uniformity discount", () => {
    const dissent = assess(botWithWeightlessDissent);
    expect(dissent.flags.uniformSentiment).toBe(true);
    expect(Math.abs((dissent.trustScore as number) - (r.uniformBot.trustScore as number))).toBeLessThanOrEqual(1);
  });

  it("case and whitespace variants of a source label are the same source type", () => {
    const plain = assess([obs("forum", 0.8), obs("forum", 0.8), obs("forum", 0.8)]);
    const variants = assess([obs("forum", 0.8), obs("Forum", 0.8), obs("  FORUM ", 0.8)]);
    expect(variants.eligibleSignalCount).toBe(3);
    expect(variants.sourceCount).toBe(1);
    expect(variants.trustScore).toBe(plain.trustScore);
    expect(variants.components).toEqual(plain.components);
    expect(variants.flags).toEqual(plain.flags);
  });

  it("future-dated evidence does not get full recency, and the explanation says so", () => {
    const future = assess([obs("forum", 0.8, { publishedAt: "2099-01-01T00:00:00Z" })]);
    const undated = assess([obs("forum", 0.8, { publishedAt: null })]);
    expect(future.components.recency).toBeLessThan(1);
    expect(future.components.recency).toBe(undated.components.recency);
    expect(future.explanation).toContain("dated after the assessment time");
  });

  it("more confirming reviews from one source type never lower the score", () => {
    const scores = [1, 2, 3, 10, 30].map((n) => score(forumReviews(n)));
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1] as number);
    for (const n of [1, 2, 3, 10]) expect(assess(forumReviews(n)).flags.lowSourceCount).toBe(true);
  });

  it("a broader, better-evidenced set never scores below a single review", () => {
    expect(score(thirtyOverThree)).toBeGreaterThanOrEqual(score(forumReviews(1)));
    expect(score(thirtyOverThree)).toBeGreaterThan(score(forumReviews(30)));
  });

  // Self-hunt rows: attempts to buy a clean score, and honest shapes that must not be over-penalized.

  it("small second source types earn proportional relief; one real post on another platform counts in full", () => {
    const ring = r.singleSourceRing.trustScore as number;
    const fiveSmallDecoys = assess([
      ...SETS.singleSourceRing,
      ...["blog", "aggregator", "marketplace", "social", "community"].map((s) => obs(s, 0.7, { confidence: 0.12 })),
    ]);
    expect(fiveSmallDecoys.flags.lowSourceCount).toBe(true);
    expect(fiveSmallDecoys.sourceCount).toBe(1);
    expect(fiveSmallDecoys.components.astroturfPenalty).toBeGreaterThan(0.1);
    expect(fiveSmallDecoys.trustScore as number).toBeGreaterThanOrEqual(ring);
    // Documented trade-off: a post with real weight is real evidence, so it counts.
    const oneRealBlog = assess([...SETS.singleSourceRing, obs("blog", 0.75)]);
    expect(oneRealBlog.flags.lowSourceCount).toBe(false);
  });

  it("future-dating a ring does not buy recency", () => {
    const futureRing = assess(SETS.singleSourceRing.map((s) => ({ ...s, publishedAt: "2027-06-01T00:00:00Z" })));
    expect(futureRing.components.recency).toBeLessThan(r.singleSourceRing.components.recency);
    expect(futureRing.trustScore as number).toBeLessThanOrEqual(r.singleSourceRing.trustScore as number);
  });

  it("a three-post identical single-source burst gets both discounts", () => {
    const burst = assess(Array.from({ length: 3 }, (_, i) => obs("forum", 1, { publishedAt: daysAgo(i) })));
    expect(burst.flags).toEqual({ lowSourceCount: true, uniformSentiment: true });
    expect(burst.components.astroturfPenalty).toBe(1);
    expect(burst.explanation).toContain("Sentiment is unusually uniform, which lowers the score.");
    expect(burst.explanation).toContain("Evidence comes from very few distinct source types, which lowers the score.");
  });

  it("one review is concentrated by definition, and a broader set outranks it", () => {
    const one = assess([obs("marketplace", stars(5))]);
    const two = assess([obs("forum", stars(5)), obs("marketplace", stars(4))]);
    expect(one.flags.lowSourceCount).toBe(true);
    expect(one.confidence.level).toBe("thin");
    expect(two.flags).toEqual({ lowSourceCount: false, uniformSentiment: false });
    expect(two.trustScore as number).toBeGreaterThan(one.trustScore as number);
  });

  it("one dominant platform: a real mention elsewhere counts, a faint one counts in proportion", () => {
    const marketplace = ratings([...repeat(30, 5), ...repeat(10, 4)], ["marketplace"], 300);
    const realMention = assess([...marketplace, obs("blog", stars(5), { publishedAt: daysAgo(60) })]);
    expect(realMention.flags.lowSourceCount).toBe(false);
    const faintMention = assess([...marketplace, obs("blog", stars(5), { confidence: 0.2, publishedAt: daysAgo(60) })]);
    expect(faintMention.flags.lowSourceCount).toBe(true);
    expect(faintMention.components.astroturfPenalty).toBeGreaterThan(0);
    expect(faintMention.components.astroturfPenalty).toBeLessThan(CONFIG.astroturf.concentrationPenalty);
  });

  it("4.96 stars still ranks at or above 4.60 stars", () => {
    const nearPerfect = assess(ratings([...repeat(24, 5), 4], FOUR, 180));
    expect(nearPerfect.trustScore as number).toBeGreaterThanOrEqual(r.enthusiastic460.trustScore as number);
  });

  it("dates a few hours ahead of now (an importer's time zone) still count as fresh", () => {
    const ahead = assess(
      ratings([...repeat(6, 5), ...repeat(4, 4)], FOUR, 0).map((s) => ({
        ...s,
        publishedAt: new Date(NOW_MS + 14 * 3600 * 1000).toISOString(),
      })),
    );
    expect(ahead.components.recency).toBe(1);
    expect(ahead.explanation).not.toContain("dated after the assessment time");
  });

  it("an importer's mixed-case labels merge into the configured source types", () => {
    const mixed = assess(ratings([...repeat(6, 5), ...repeat(4, 4), 3], ["Forum", "MARKETPLACE ", " blog", "forum"], 120));
    expect(mixed.eligibleSignalCount).toBe(11);
    expect(mixed.sourceCount).toBe(3);
  });

  it("weights summing above 1 cannot absorb the pattern discount", () => {
    const heavy = resolveAnonymousConfig({ weights: { consensus: 0.8, diversity: 0.5, volume: 0.4, recency: 0.3 } });
    const varied = Array.from({ length: 8 }, (_, i) => obs(FOUR[i % 4] as string, 0.5 + 0.05 * i));
    const flagged = assess(SETS.uniformBot, heavy);
    expect(flagged.flags.uniformSentiment).toBe(true);
    expect(flagged.trustScore as number).toBeLessThan(100);
    expect(flagged.trustScore as number).toBeLessThan(score(varied, heavy));
  });
});

describe("verdict table: known limits (documented in README, Honest limits)", () => {
  // These pin behavior the heuristics cannot catch. If a change makes one of
  // them fail, that is a deliberate verdict change: update README and CHANGELOG.

  it("a ring that puts real weight on a second source type clears the concentration discount", () => {
    const spread = assess([...SETS.singleSourceRing, ...[0, 1, 2].map(() => obs("blog", 0.75))]);
    expect(spread.flags.lowSourceCount).toBe(false);
  });

  it("one real dissenting review, or about 1% of the weight far from the mean, clears the uniformity discount", () => {
    const oneDissent = assess([...SETS.uniformBot, obs("forum", 0.2)]);
    const lowWeightDissent = assess([...SETS.uniformBot, ...[0, 1].map(() => obs("aggregator", -0.5, { confidence: 0.2 }))]);
    expect(oneDissent.flags.uniformSentiment).toBe(false);
    expect(lowWeightDissent.flags.uniformSentiment).toBe(false);
  });

  it("identical sentiment at or below the uniformity mean threshold is not discounted", () => {
    const flat = assess(Array.from({ length: 20 }, (_, i) => obs(FOUR[i % 4] as string, 0.85, { publishedAt: daysAgo(i % 14) })));
    expect(flat.flags.uniformSentiment).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Identified mode
// ---------------------------------------------------------------------------

function known(id: string, value: number, overrides: Partial<IdentifiedSignal> = {}): IdentifiedSignal {
  return {
    id,
    tier: "verified",
    source: "direct",
    proof: "verified",
    reputation: null,
    occurredAt: daysAgo(30),
    value,
    ...overrides,
  };
}

describe("verdict table: review round 2 (ring at 0.9, piling up, labels, gate)", () => {
  const OTHERS = ["forum", "community", "aggregator", "blog", "social"] as const;
  /** 30 marketplace posts plus 2 on each of five other source types, with the given sentiments. */
  const footprint = (sentimentAt: (i: number) => number): AnonymousSignal[] => [
    ...Array.from({ length: 30 }, (_, i) => obs("marketplace", sentimentAt(i), { publishedAt: daysAgo(i * 6) })),
    ...OTHERS.flatMap((s, k) => [0, 1].map((j) => obs(s, sentimentAt(30 + 2 * k + j), { publishedAt: daysAgo(10 + j * 40) }))),
  ];
  /** A J-shaped star distribution (many 5s, some 1s), interleaved deterministically. */
  const J = [5, 5, 4, 5, 5, 1, 5, 4, 5, 3, 5, 5, 2, 5, 4, 5, 5, 1, 5, 5];

  it("P1-A: identical 0.9 praise on an honest footprint ranks below an honest J-shaped set", () => {
    const ring = assess(footprint(() => 0.9));
    const honest = assess(footprint((i) => stars(J[i % J.length] as number)));
    expect(ring.flags.uniformSentiment).toBe(true);
    expect(ring.components.astroturfPenalty).toBeGreaterThanOrEqual(0.3);
    expect(honest.flags).toEqual({ lowSourceCount: false, uniformSentiment: false });
    expect(ring.trustScore as number).toBeLessThan(honest.trustScore as number);
  });

  it("P1-A: identical praise from 0.88 up gets most of the uniformity discount, even one post per type", () => {
    for (const v of [0.88, 0.9, 0.92]) expect(assess(footprint(() => v)).components.astroturfPenalty).toBeGreaterThanOrEqual(0.2);
    const six = assess(["forum", "community", "marketplace", "aggregator", "blog", "social"].map((s) => obs(s, 0.9)));
    expect(six.flags.uniformSentiment).toBe(true);
    expect(six.components.astroturfPenalty).toBeGreaterThanOrEqual(0.3);
  });

  it("P1-B: piling up same-platform reviews next to one other-platform post never lowers the score", () => {
    const pile = (k: number, other: string, n = 1) => [
      ...Array.from({ length: n }, () => obs(other, 0.6)),
      ...Array.from({ length: k }, () => obs("forum", 0.6)),
    ];
    const aggregator = [1, 8, 20, 40].map((k) => score(pile(k, "aggregator")));
    for (let i = 1; i < aggregator.length; i++) expect(aggregator[i]).toBeGreaterThanOrEqual(aggregator[i - 1] as number);
    expect(score(pile(80, "blog", 3))).toBeGreaterThanOrEqual(score(pile(20, "blog", 3)));
  });

  it("P1-B: a near-weightless second platform still counts for almost nothing", () => {
    const decoyed = assess([...SETS.singleSourceRing, obs("aggregator", 0.7, { confidence: 0.001 })]);
    expect(decoyed.flags.lowSourceCount).toBe(true);
    expect(decoyed.components.astroturfPenalty).toBeGreaterThan(0.59);
  });

  it("P2: a case or space variant of a shipped source type overrides it instead of throwing", () => {
    const config = resolveAnonymousConfig({ sourceWeights: { Forum: 1 } });
    const viaVariant = assess([obs("forum", 0.8)], config);
    const explicit = assess([obs("forum", 0.8)], resolveAnonymousConfig({ sourceWeights: { forum: 1 } }));
    expect(viaVariant).toEqual(explicit);
    expect(() => resolveAnonymousConfig({ sourceWeights: { Forum: 1, " forum": 0.5 } })).toThrow(RangeError);
  });

  it("P2: near-integer effective counts are not floored by roundoff", () => {
    // Source b carries 0.6 of 12.0 total weight (5%) and, at 0.6, at least the full-count weight. In
    // floating point the dominant source's total lands a hair above 11.4, which used to floor the
    // effective count from 2 to 1 and flag concentration.
    const config = resolveAnonymousConfig({ sourceWeights: { a: 1, b: 1 } });
    const corpus = [
      ...Array.from({ length: 17 }, () => obs("a", 0.3, { confidence: 11.4 / 17, publishedAt: NOW })),
      obs("b", 0.3, { confidence: 0.3, publishedAt: NOW }),
      obs("b", 0.3, { confidence: 0.3, publishedAt: NOW }),
    ];
    const result = assess(corpus, config);
    expect(result.sourceCount).toBe(2);
    expect(result.flags.lowSourceCount).toBe(false);
    expect(result.components.astroturfPenalty).toBe(0);
  });

  it("P3: the uniformity minimum counts effective observations, so a near-weightless third post does not open it", () => {
    const two = assess([obs("forum", 1), obs("blog", 1)]);
    const padded = assess([obs("forum", 1), obs("blog", 1), obs("social", 1, { confidence: 0.02 })]);
    expect(two.flags.uniformSentiment).toBe(false);
    expect(padded.flags.uniformSentiment).toBe(false);
  });

  it("P3: the explanation calls the count what it is: effective source types", () => {
    expect(assess(SETS.mixedHonest).explanation).toContain("effective source types (independence not verified)");
  });
});

describe("verdict table: review round 3 (age and breadth, config coupling, flag truth)", () => {
  const SIX = ["forum", "community", "marketplace", "aggregator", "blog", "social"] as const;

  it("P1: old evidence counts for breadth like fresh evidence (age lowers recency, not breadth)", () => {
    const oldEach = assess(SIX.map((s) => obs(s, 0.6, { publishedAt: daysAgo(1100) })));
    const freshEach = assess(SIX.map((s) => obs(s, 0.6, { publishedAt: daysAgo(5) })));
    expect(oldEach.flags.lowSourceCount).toBe(false);
    expect(oldEach.sourceCount).toBe(6);
    expect(oldEach.components.diversity).toBe(freshEach.components.diversity);
    expect(oldEach.components.recency).toBeLessThan(freshEach.components.recency);
  });

  it("P1: undated mentions count for breadth", () => {
    const undated = assess([...[0, 1, 2].map(() => obs("blog", 0.6, { publishedAt: null })), obs("social", 0.6, { publishedAt: null })]);
    expect(undated.flags.lowSourceCount).toBe(false);
    expect(undated.sourceCount).toBe(2);
  });

  it("P1: one old mention on each of five other platforms gives an honest set full breadth", () => {
    const honest = assess([
      ...ratings([...repeat(25, 5), ...repeat(7, 4), ...repeat(3, 3), ...repeat(2, 2), ...repeat(3, 1)], ["marketplace"], 700),
      ...["forum", "community", "aggregator", "blog", "social"].map((s, i) => obs(s, stars(4), { publishedAt: daysAgo(365 + i * 80) })),
    ]);
    expect(honest.flags).toEqual({ lowSourceCount: false, uniformSentiment: false });
    expect(honest.sourceCount).toBe(6);
  });

  it("P2: an unused, highly weighted source type in the config changes nothing", () => {
    const four = ["forum", "marketplace", "blog", "social"].map((s) => obs(s, 0.6, { publishedAt: daysAgo(5) }));
    const withUnused = resolveAnonymousConfig({ sourceWeights: { verified: 2 } });
    expect(assess(four, withUnused)).toEqual(assess(four));
  });

  it("P2: with concentrationPenalty 0, nothing claims concentration lowered the score", () => {
    const noConcentration = resolveAnonymousConfig({ astroturf: { ...CONFIG.astroturf, concentrationPenalty: 0 } });
    const one = assess([obs("forum", 0.6)], noConcentration);
    expect(one.components.astroturfPenalty).toBe(0);
    expect(one.flags.lowSourceCount).toBe(false);
    expect(one.explanation).not.toContain("very few distinct source types, which lowers the score");
  });

  it("documented trade-off, both directions: one fresh post per platform clears a ring's concentration; a faint one does not", () => {
    const ring = Array.from({ length: 30 }, (_, i) => obs("marketplace", i % 2 ? 1 : 0.5, { publishedAt: daysAgo(i) }));
    const fresh = assess([...ring, ...["forum", "community", "aggregator", "blog", "social"].map((s) => obs(s, 1, { publishedAt: daysAgo(2) }))]);
    const faint = assess([...ring, ...["forum", "community", "aggregator", "blog", "social"].map((s) => obs(s, 1, { confidence: 0.01 }))]);
    expect(fresh.flags.lowSourceCount).toBe(false);
    expect(faint.flags.lowSourceCount).toBe(true);
  });
});

describe("verdict table: identified mode", () => {
  const config = EXAMPLE_IDENTIFIED_CONFIG;

  it("future-dated evidence is weighted like undated evidence, not as perfectly fresh", () => {
    const future = scoreEntity([known("f", 100, { occurredAt: "2031-01-01T00:00:00Z" })], config, { now: NOW, prior: 50 });
    const undated = scoreEntity([known("u", 100, { occurredAt: null })], config, { now: NOW, prior: 50 });
    const fresh = scoreEntity([known("n", 100, { occurredAt: NOW })], config, { now: NOW, prior: 50 });
    expect(future.contributions[0]?.weight).toBe(undated.contributions[0]?.weight);
    expect(future.contributions[0]?.weight).toBeLessThan(fresh.contributions[0]?.weight as number);
    expect(future.contributions[0]?.ageDays).toBeNull();
  });

  it("a timestamp less than a day ahead (clock skew) still counts as fresh", () => {
    const skewed = scoreEntity([known("s", 100, { occurredAt: "2026-10-01T06:00:00Z" })], config, { now: NOW, prior: 50 });
    const fresh = scoreEntity([known("n", 100, { occurredAt: NOW })], config, { now: NOW, prior: 50 });
    expect(skewed.contributions[0]?.weight).toBe(fresh.contributions[0]?.weight);
    expect(skewed.contributions[0]?.ageDays).toBe(0);
  });

  it("composeDimensions does not present a bare prior as measured, and has no 0 for 'no data'", () => {
    const empty = scoreEntity([], config, { now: NOW, prior: 80 });
    const measured = scoreEntity(
      Array.from({ length: 12 }, (_, i) => known(`m${i}`, 40)),
      config,
      { now: NOW, prior: 50 },
    );
    expect(composeDimensions({ quality: empty }, { quality: 1 })).toBeNull();
    expect(composeDimensions({ quality: measured }, {})).toBeNull();
    // An insufficient dimension that carries no weight is simply not part of the composite.
    expect(composeDimensions({ quality: empty, reliability: measured }, { reliability: 1 })).toBe(measured.score);
  });

  it("P2: an empty dimension is dropped and the rest renormalized, and the drop is visible", () => {
    const empty = scoreEntity([], config, { now: NOW, prior: 80 });
    const measured = scoreEntity(Array.from({ length: 12 }, (_, i) => known(`m${i}`, 40)), config, { now: NOW, prior: 50 });
    expect(composeDimensions({ quality: empty, reliability: measured }, { quality: 1, reliability: 1 })).toBe(measured.score);
    expect(composeDimensionsDetailed({ quality: empty, reliability: measured }, { quality: 1, reliability: 1 })).toEqual({
      score: measured.score,
      measured: ["reliability"],
      unmeasured: ["quality"],
    });
  });

  it("P2 (round 3): composeDimensions has no cliff as a thin dimension gains evidence", () => {
    const quality = scoreEntity(Array.from({ length: 30 }, (_, i) => known(`q${i}`, 85)), config, { now: NOW, prior: 60 });
    // new/direct/none at reputation 81 and 82 weigh 0.2496 and 0.2512: either side of 0.25.
    const thin = (rep: number) =>
      scoreEntity([known("t", 95, { tier: "new", proof: "none", reputation: rep, occurredAt: NOW })], config, { now: NOW, prior: 70 });
    const below = thin(81);
    const above = thin(82);
    expect(below.nEff).toBeLessThan(0.25);
    expect(above.nEff).toBeGreaterThan(0.25);
    const w = { quality: 2, reliability: 1 };
    const a = composeDimensions({ quality, reliability: below }, w) as number;
    const b = composeDimensions({ quality, reliability: above }, w) as number;
    expect(Math.abs(a - b)).toBeLessThan(0.5);
    expect(composeDimensionsDetailed({ quality, reliability: below }, w).measured).toEqual(["quality", "reliability"]);
  });

  it("P2: a single near-weightless signal barely moves the composite", () => {
    const quality = scoreEntity(Array.from({ length: 30 }, (_, i) => known(`q${i}`, 85)), config, { now: NOW, prior: 60 });
    const nearBare = scoreEntity(
      [known("b", 10, { tier: "new", source: "imported", proof: "none", occurredAt: "2020-01-01T00:00:00Z" })],
      config,
      { now: NOW, prior: 70 },
    );
    expect(nearBare.confidence.level).toBe("thin");
    expect(nearBare.nEff).toBeLessThan(0.25);
    const composite = composeDimensions({ quality, reliability: nearBare }, { quality: 2, reliability: 1 }) as number;
    // Reliability's weight is scaled by nEff / 0.25, so its near-prior score pulls the composite by well under a point.
    expect(Math.abs(composite - quality.score)).toBeLessThan(1);
    expect(composeDimensionsDetailed({ quality, reliability: nearBare }, { quality: 2, reliability: 1 }).unmeasured).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

const ANON_SOURCES = ["forum", "community", "marketplace", "aggregator", "blog", "social"] as const;

function randomCorpus(rand: () => number): AnonymousSignal[] {
  const size = 1 + Math.floor(rand() * 25);
  const breadth = 1 + Math.floor(rand() * ANON_SOURCES.length);
  return Array.from({ length: size }, () =>
    obs(ANON_SOURCES[Math.floor(rand() * breadth)] as string, Math.round((rand() * 2 - 1) * 100) / 100, {
      confidence: 0.05 + Math.round(rand() * 95) / 100,
      publishedAt: rand() < 0.1 ? null : daysAgo(Math.floor(rand() * 2000)),
    }),
  );
}

describe("property: anonymous monotonicity (seeded fuzz)", () => {
  it("a confirming observation, from any source type, can lower the score only by raising the uniformity discount", () => {
    // A confirming observation agrees with the corpus (sentiment at or above
    // its weighted mean) and is published at `now`. Source types count by
    // their own weight, so it can never make another source type count for
    // less: the only way it can lower the score is by making the corpus look
    // more uniform (a larger astroturfPenalty, including the uniformity
    // minimum starting to apply).
    const rand = mulberry32(20261010);
    let checked = 0;
    for (let trial = 0; trial < 600; trial++) {
      const corpus = randomCorpus(rand);
      const before = assess(corpus);
      if (before.trustScore === null) continue;
      const weightedMean = before.components.consensus * 2 - 1;
      const sentiment = Math.min(1, weightedMean + rand() * (1 - weightedMean));
      const source = ANON_SOURCES[Math.floor(rand() * ANON_SOURCES.length)] as string;
      const added = obs(source, sentiment, { confidence: 0.05 + rand() * 0.95, publishedAt: NOW });
      const after = assess([...corpus, added]);
      expect(after.components.volume).toBeGreaterThanOrEqual(before.components.volume);
      expect(after.components.diversity).toBeGreaterThanOrEqual(before.components.diversity);
      if (!before.flags.lowSourceCount) expect(after.flags.lowSourceCount).toBe(false);
      if (!(after.components.astroturfPenalty > before.components.astroturfPenalty)) {
        expect(after.trustScore as number).toBeGreaterThanOrEqual(before.trustScore);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(200);
  }, 60_000);

  it("repeating every observation never lowers the score, unless the uniformity minimum starts to apply", () => {
    const rand = mulberry32(7);
    for (let trial = 0; trial < 300; trial++) {
      const corpus = randomCorpus(rand);
      const before = assess(corpus);
      if (before.trustScore === null) continue;
      const after = assess([...corpus, ...corpus.map((s) => ({ ...s, id: `${s.id}-copy` }))]);
      // Shares, the weighted mean and the weighted variance are unchanged; every source type's own weight doubles.
      expect(after.components.consensus).toBe(before.components.consensus);
      expect(after.components.volume).toBeGreaterThanOrEqual(before.components.volume);
      if ((after.trustScore as number) < before.trustScore) {
        expect(after.flags.uniformSentiment && !before.flags.uniformSentiment).toBe(true);
      }
    }
  }, 60_000);
});

describe("property: identified monotonicity (seeded fuzz)", () => {
  it("adding a signal whose value is at or above the current score never lowers the score", () => {
    const rand = mulberry32(99);
    const tiers = ["new", "standard", "verified", "expert"];
    const sources = ["imported", "referred", "direct"];
    const proofs = ["none", "self_attested", "verified", "documented"];
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)] as T;
    const random = (id: string, value: number): IdentifiedSignal => ({
      id,
      tier: pick(tiers),
      source: pick(sources),
      proof: pick(proofs),
      reputation: rand() < 0.2 ? null : Math.floor(rand() * 101),
      occurredAt: rand() < 0.15 ? null : daysAgo(Math.floor(rand() * 1500)),
      value,
    });
    for (let trial = 0; trial < 500; trial++) {
      const signals = Array.from({ length: Math.floor(rand() * 15) }, (_, i) => random(`s${i}`, Math.floor(rand() * 101)));
      const before = scoreEntity(signals, EXAMPLE_IDENTIFIED_CONFIG, { now: NOW, prior: 60 });
      const value = Math.min(100, Math.ceil(before.score) + Math.floor(rand() * 10));
      const after = scoreEntity([...signals, random("added", value)], EXAMPLE_IDENTIFIED_CONFIG, { now: NOW, prior: 60 });
      expect(after.score).toBeGreaterThanOrEqual(before.score - 1e-12);
    }
  }, 60_000);
});

describe("property: order independence (seeded fuzz)", () => {
  const shuffle = <T>(list: T[], rand: () => number): T[] => {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
    }
    return copy;
  };

  it("anonymous: any order of the same observations gives the identical result", () => {
    const rand = mulberry32(31337);
    for (let trial = 0; trial < 300; trial++) {
      const corpus = randomCorpus(rand).map((s, i) => (i % 3 === 0 ? { ...s, source: ` ${s.source.toUpperCase()}` } : s));
      expect(assess(shuffle(corpus, rand))).toEqual(assess(corpus));
    }
  }, 60_000);

  it("identified: any order of the same signals gives the identical result", () => {
    const rand = mulberry32(4242);
    for (let trial = 0; trial < 300; trial++) {
      const signals = Array.from({ length: 1 + Math.floor(rand() * 15) }, (_, i) =>
        known(`k${i}`, Math.floor(rand() * 101), {
          tier: ["new", "standard", "verified", "expert"][Math.floor(rand() * 4)] as string,
          reputation: rand() < 0.3 ? null : Math.floor(rand() * 101),
          occurredAt: rand() < 0.2 ? null : daysAgo(Math.floor(rand() * 900) - 3),
        }),
      );
      const options = { now: NOW, prior: 55 };
      expect(scoreEntity(shuffle(signals, rand), EXAMPLE_IDENTIFIED_CONFIG, options)).toEqual(
        scoreEntity(signals, EXAMPLE_IDENTIFIED_CONFIG, options),
      );
    }
  }, 60_000);
});

describe("property: weight scale", () => {
  // Identified weights are on an absolute scale: 1.0 is one reference signal,
  // the dial counts phantom signals of weight 1.0, and the confidence
  // thresholds count weight. Scaling every weight by k is therefore exactly
  // the same as dividing the dial and the thresholds by k. This is the
  // documented contract (README, "Weight scale"), not scale invariance:
  // making confidence scale-free would stop "ten weak signals carry less than
  // one strong one" from meaning anything.
  const timesTier = (k: number): IdentifiedConfig =>
    resolveIdentifiedConfig({
      tierWeights: Object.fromEntries(Object.entries(EXAMPLE_IDENTIFIED_CONFIG.tierWeights).map(([key, w]) => [key, w * k])),
      confidence: { high: 8 * k, moderate: 3 * k },
    });

  it("identified: raw is scale-free, and scaling weights by k equals dividing the dial and thresholds by k", () => {
    const rand = mulberry32(5);
    for (let trial = 0; trial < 100; trial++) {
      const signals = Array.from({ length: 1 + Math.floor(rand() * 12) }, (_, i) =>
        known(`w${i}`, Math.floor(rand() * 101), {
          tier: ["new", "standard", "verified", "expert"][Math.floor(rand() * 4)] as string,
        }),
      );
      const base = scoreEntity(signals, EXAMPLE_IDENTIFIED_CONFIG, { now: NOW, prior: 50, dial: 4 });
      for (const k of [0.25, 4]) {
        const result = scoreEntity(signals, timesTier(k), { now: NOW, prior: 50, dial: 4 * k });
        expect(result.raw).toBeCloseTo(base.raw as number, 9);
        expect(result.nEff).toBeCloseTo(base.nEff * k, 9);
        expect(result.score).toBeCloseTo(base.score, 9);
        expect(result.confidence.level).toBe(base.confidence.level);
      }
    }
  }, 60_000);

  it("anonymous: scaling every source credibility and the full-count weight by a constant changes nothing", () => {
    const rand = mulberry32(11);
    // The full-count weight is on the same scale, so it scales with them.
    const times4 = resolveAnonymousConfig({
      sourceWeights: Object.fromEntries(Object.entries(CONFIG.sourceWeights).map(([key, w]) => [key, w * 4])),
      fullCountWeight: (CONFIG.fullCountWeight as number) * 4,
    });
    for (let trial = 0; trial < 200; trial++) {
      const corpus = randomCorpus(rand);
      expect(assess(corpus, times4)).toEqual(assess(corpus));
    }
  }, 60_000);
});
