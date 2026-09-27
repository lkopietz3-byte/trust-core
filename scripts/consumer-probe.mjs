// Consumer probe: imports trust-core BY NAME from the installed tarball (the
// way a real dependent would) and exercises the real API, asserting real
// outputs — not just "it exports something."
import assert from "node:assert/strict";

const root = await import("trust-core");
const identified = await import("trust-core/identified");
const anonymous = await import("trust-core/anonymous");
const shared = await import("trust-core/shared");

// --- trust-core (root): namespace re-exports work and agree with the subpaths ---
assert.equal(root.identified.scoreEntity, identified.scoreEntity, "root identified namespace should be identified/index.js");
assert.equal(root.anonymous.assessAuthenticity, anonymous.assessAuthenticity, "root anonymous namespace should be anonymous/index.js");
assert.equal(root.clamp, shared.clamp, "root should re-export shared/types.js directly");

// --- trust-core/shared: the primitives compute what they document ---
assert.equal(shared.clamp(15, 0, 10), 10, "clamp should bound to the max");
assert.equal(shared.clamp01(-1), 0, "clamp01 should bound to 0");
assert.equal(shared.daysBetween("2026-01-01T00:00:00Z", "2026-01-11T00:00:00Z"), 10, "daysBetween should count whole days");
assert.equal(shared.recencyDecay(0, 100), 1, "recencyDecay at age 0 should be full weight");
assert.equal(shared.shrinkTowardPrior(0, 0, 55, 4), 55, "shrinkTowardPrior with no evidence should collapse to the prior");
assert.equal(shared.resolveDial("balanced"), shared.TRUST_DIALS.balanced.C, "resolveDial should resolve the named preset");
assert.throws(() => shared.resolveDial("nonexistent-preset"), RangeError, "resolveDial should reject an unknown preset");
assert.equal(shared.confidenceFromSampleSize(10, { high: 8, moderate: 3 }).level, "high");

// --- trust-core/identified: score a small, realistic dataset ---
const idConfig = identified.resolveIdentifiedConfig({
  tierWeights: { new: 0.4, verified: 1.0 },
  sourceWeights: { direct: 1.0 },
  proofWeights: { none: 0.5, receipt: 1.15 },
  reputation: { floor: 0.6, ceil: 1.4, neutral: 1.0 },
  recency: { halfLifeDays: 365, missingDateAgeDays: 365 },
  confidence: { high: 8, moderate: 3 },
});
const idSignals = [
  {
    id: "r1",
    tier: "verified",
    source: "direct",
    proof: "receipt",
    reputation: 90,
    occurredAt: "2026-06-01T00:00:00Z",
    value: 92,
  },
];
const idResult = identified.scoreEntity(idSignals, idConfig, {
  asOf: "2026-08-01T00:00:00Z",
  prior: 50,
  dial: "balanced",
});
assert.equal(typeof idResult.score, "number");
assert.ok(idResult.score >= 0 && idResult.score <= 100, `score ${idResult.score} should be in [0, 100]`);
assert.ok(idResult.score > 50, "one strong, credible signal should pull the score above the 50 prior");
assert.equal(idResult.signalCount, 1);

// Validation: a malformed signal must throw, not silently degrade.
assert.throws(
  () => identified.scoreEntity([{ ...idSignals[0], value: 500 }], idConfig, { asOf: "2026-08-01T00:00:00Z", prior: 50 }),
  RangeError,
  "an out-of-range signal value should throw, not silently produce an out-of-range score",
);
assert.throws(
  () => identified.signalWeight({ ...idSignals[0], tier: "constructor" }, idConfig, "2026-08-01T00:00:00Z"),
  /no weight configured/,
  "a prototype-chain tier name should be treated as unconfigured, not resolve to an inherited value",
);

// --- trust-core/anonymous: assess a small, realistic corpus ---
const anonConfig = anonymous.resolveAnonymousConfig({
  sourceWeights: { forum: 0.85, blog: 0.6 },
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
const anonSignals = [
  { id: "s1", source: "forum", sentiment: 0.7, confidence: 0.9, publishedAt: "2026-07-01T00:00:00Z" },
  { id: "s2", source: "blog", sentiment: 0.6, confidence: 0.8, publishedAt: "2026-06-15T00:00:00Z" },
];
const anonResult = anonymous.assessAuthenticity(anonSignals, anonConfig, { now: "2026-08-01T00:00:00Z" });
assert.equal(typeof anonResult.trustScore, "number");
assert.ok(Number.isInteger(anonResult.trustScore) && anonResult.trustScore >= 0 && anonResult.trustScore <= 100);
assert.equal(anonResult.sourceCount, 2);
assert.equal(typeof anonResult.explanation, "string");

// Validation: out-of-range sentiment must throw.
assert.throws(
  () => anonymous.assessAuthenticity([{ ...anonSignals[0], sentiment: 5 }], anonConfig, { now: "2026-08-01T00:00:00Z" }),
  RangeError,
  "an out-of-range sentiment should throw, not silently corrupt the composite",
);

// --- immutability: exported example configs cannot be mutated by a consumer ---
assert.throws(() => {
  identified.EXAMPLE_IDENTIFIED_CONFIG.tierWeights.new = 999;
}, TypeError, "EXAMPLE_IDENTIFIED_CONFIG should be frozen against mutation");
assert.throws(() => {
  anonymous.EXAMPLE_ANONYMOUS_CONFIG.sourceWeights.forum = 999;
}, TypeError, "EXAMPLE_ANONYMOUS_CONFIG should be frozen against mutation");

console.log("consumer-probe: all assertions passed");
