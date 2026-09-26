# trust-core

Two complementary lenses on entity trust: score signals from contributors you know, and weigh how organic a corpus of anonymous sentiment looks when you don't. Zero runtime dependencies, ESM, framework-agnostic TypeScript. These are configurable weighted-average heuristics over the signals you supply — not a truth detector, a fraud detector, or a certification. See **Honest limits** below before you rely on either module for something adversarial.

## What it is

Any product that ranks or vouches for entities — a stylist directory, a contractor marketplace, a vendor list, a product-review aggregator — ends up needing two different kinds of trust math. `identified/` scores signals from contributors you know: reviewers, raters, inspectors with an account and a history, weighted by their tier, source, proof-of-something, reputation, and recency, then shrunk toward a domain baseline so thin evidence doesn't swing a score. `anonymous/` assesses signals from contributors you don't know: scraped mentions, imported reviews, aggregator feeds with no verifiable identity, scored for source diversity, volume, recency, and consensus, then discounted when the evidence looks planted rather than organic. Both are pure functions — no I/O, no clock, no randomness beyond what you pass in — so results are deterministic and testable.

## Why one library, not two

A real product almost always needs both halves at once. You trust your known reviewers (weighted by their track record) *and* you need to catch astroturf from anonymous sources (weighted by whether the pattern of praise looks organic) — they are not the same problem, and conflating them either lets manipulation through your reviewer pipeline or drowns your best-informed contributors' judgment in statistical noise from a corpus with no identities attached. Building them as one library — sharing a weight primitive, a recency-decay curve, a shrink-toward-baseline move, and a confidence label — means a new product picks up both patterns from a single import instead of re-deriving one of them from scratch, and the two stay legibly related instead of drifting into incompatible conventions over time.

## Install

Not yet published to npm. Install from GitHub until it is:

```bash
npm install github:lkopietz3-byte/trust-core
```

## `identified` — score known contributors

```ts
import { identified } from "trust-core";
// or: import { scoreEntity, resolveIdentifiedConfig } from "trust-core/identified";

// Every weight is yours to define — this example is a vendor directory
// where reviewers have an account tier, a source, and a proof-of-purchase.
const config = identified.resolveIdentifiedConfig({
  tierWeights: { new: 0.4, standard: 0.7, verified: 1.0, expert: 1.3 },
  sourceWeights: { imported: 0.5, direct: 1.0 },
  proofWeights: { none: 0.5, receipt: 1.15 },
  reputation: { floor: 0.6, ceil: 1.4, neutral: 1.0 },
  recency: { halfLifeDays: 365, missingDateAgeDays: 365 },
  confidence: { high: 8, moderate: 3 },
});

const signals: identified.IdentifiedSignal[] = [
  {
    id: "r1",
    tier: "verified",
    source: "direct",
    proof: "receipt",
    reputation: 85,
    occurredAt: "2026-06-01T00:00:00Z",
    value: 92, // this signal's 0-100 rating of the vendor
  },
  {
    id: "r2",
    tier: "new",
    source: "imported",
    proof: "none",
    reputation: null,
    occurredAt: "2026-01-01T00:00:00Z",
    value: 60,
  },
];

const result = identified.scoreEntity(signals, config, {
  asOf: "2026-08-01T00:00:00Z",
  prior: 55, // the category baseline — e.g. the pooled mean across all vendors
  dial: "balanced", // "as_is" | "balanced" | "strict", or a raw number
});

result.score;       // 64.08 — pulled from the 90.45 raw mean toward the 55 prior
result.raw;          // 90.45 — unshrunk credibility-weighted mean, or null with no evidence
result.nEff;         // 1.38 — effective sample size (sum of signal weights), not a raw count of 2
result.confidence;   // { level: "thin", effectiveSampleSize: 1.38 } — nEff is well below the "moderate" threshold of 3
result.contributions; // per-signal weight breakdown, heaviest first
```

This is the actual output of the snippet above, run against the built package — `r1`'s verified/direct/receipt/reputation-85 profile outweighs `r2`'s new/imported/none profile by about 20 to 1, but neither is enough evidence (`nEff` of 1.38, versus a `balanced` dial strength of 4) to move the score far from the 55 prior.

`scoreEntity` validates as it goes: `value` and `reputation` must be in `[0, 100]` (or `null` for reputation), `occurredAt`/`asOf` must be strict ISO 8601 timestamps, `prior` must be in `[0, 100]`, and `dial` must be a known preset name or a finite number `>= 0`. A signal referencing a `tier`/`source`/`proof` with no configured weight — including a prototype property name like `"constructor"`, which is treated as absent rather than silently resolving to a non-numeric value — throws too. Every one of these throws a `TypeError` (wrong type) or `RangeError` (right type, bad value) instead of letting a bad input quietly turn into a `NaN` or out-of-range score.

The trust dial controls how hard a score is pulled toward the prior when evidence is thin:

```ts
identified.scoreEntity(signals, config, { asOf, prior: 55, dial: "as_is" });   // trust the numbers
identified.scoreEntity(signals, config, { asOf, prior: 55, dial: "balanced" }); // sensible default
identified.scoreEntity(signals, config, { asOf, prior: 55, dial: "strict" });  // demand deep evidence
identified.scoreEntity(signals, config, { asOf, prior: 55, dial: 6 });        // or your own C
```

Scoring more than one dimension (quality, reliability, communication) for the same entity — call `scoreEntity` once per dimension, then combine:

```ts
const quality = identified.scoreEntity(qualitySignals, config, { asOf, prior: 60 });
const reliability = identified.scoreEntity(reliabilitySignals, config, { asOf, prior: 70 });

const composite = identified.composeDimensions(
  { quality, reliability },
  { quality: 2, reliability: 1 }, // your product's own dimension weights
);
```

## `anonymous` — assess authenticity of unattributed signals

```ts
import { anonymous } from "trust-core";
// or: import { assessAuthenticity, resolveAnonymousConfig } from "trust-core/anonymous";

const config = anonymous.resolveAnonymousConfig({
  // "Localness"/credibility per source type — your own taxonomy.
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

const signals: anonymous.AnonymousSignal[] = [
  { id: "s1", source: "forum", sentiment: 0.7, confidence: 0.9, publishedAt: "2026-07-01T00:00:00Z" },
  { id: "s2", source: "marketplace", sentiment: 0.4, confidence: 0.8, publishedAt: "2026-06-15T00:00:00Z" },
  { id: "s3", source: "blog", sentiment: 0.8, confidence: 0.85, publishedAt: "2026-05-20T00:00:00Z" },
];

const verdict = anonymous.assessAuthenticity(signals, config, { now: "2026-08-01T00:00:00Z" });

verdict.trustScore;   // 83
verdict.components;   // { consensus: 0.83, diversity: 1, volume: 0.54, recency: 0.94, astroturfPenalty: 0 }
verdict.flags;         // { lowSourceCount: false, uniformSentiment: false }
verdict.confidence;   // { level: "moderate", effectiveSampleSize: 3 } — 3 independent sources
verdict.explanation;  // "Trust 83/100 across 3 independent sources. Sentiment is strongly positive."
```

This is the actual output of the snippet above, run against the built package — three signals from three different, credible sources, all recently published and positive, with nothing uniform or concentrated enough to trip the astroturf checks.

The astroturf penalty fires on either of two conditions, and either is enough to discount the score:

- **Concentration** — the evidence comes from too few independent sources (`sourceCount <= concentrationSourceCeiling`).
- **Uniformity** — sentiment is near-maximal with near-zero variance (`mean > uniformMeanThreshold && variance < uniformVarianceThreshold`) — no organic dissent, the fingerprint of copy-pasted or purchased praise.

`assessAuthenticity` validates as it goes: `sentiment` must be in `[-1, 1]`, `confidence` in `[0, 1]`, and `publishedAt`/`now` must be strict ISO 8601 timestamps. A signal's `source` with no configured weight (including a prototype property name like `"constructor"`) is treated as an unweighted, unclassified source — the documented `0`-credibility default — rather than resolving to a non-numeric value. Every validation failure throws a `TypeError` or `RangeError` instead of letting a bad input quietly corrupt `trustScore`.

The four `weights` (`consensus`/`diversity`/`volume`/`recency`) do **not** need to sum to 1 and are **not** normalized — they're used exactly as given in the weighted sum, so halving every weight halves the pre-penalty composite rather than leaving `trustScore` unchanged. Summing to 1 is just what keeps the composite intuitively readable as a 0-100 scale; it isn't enforced.

## The shared toolkit

`src/shared/types.ts` holds the primitives both modules are built from, so they read as one system rather than two unrelated files bundled together:

- `clamp` / `clamp01` — bound a number into a range / into `[0, 1]`.
- `Weight` — the shared type alias for a signal's credibility multiplier.
- `recencyDecay(ageDays, halfLifeDays)` / `daysBetween(fromISO, toISO)` — the exponential decay curve both modules use, one for "time since the event happened," one for "time since the material was published."
- `shrinkTowardPrior(weightedSum, totalWeight, prior, dial)` — pull a weighted mean toward a baseline by a configurable strength.
- `TRUST_DIALS` / `TrustDialPreset` / `resolveDial` — the named `as_is` / `balanced` / `strict` shrinkage presets, and a resolver that also accepts a raw number.
- `confidenceFromSampleSize(n, thresholds)` — the `high` / `moderate` / `thin` confidence label, derived from an effective sample size (signal weight sum for `identified`, independent source count for `anonymous`).

## Determinism, validation, and immutability

Both `scoreEntity` and `assessAuthenticity` are pure functions: no `Date.now()`, no `Math.random()`, no I/O. Given the same arguments they return the exact same result, including in the last bit — every internal sum (signal weights, weighted values, consensus/recency accumulators) uses an order-independent, correctly-rounded summation algorithm, so the result does not depend on what order you list your signals in and does not drift as the count grows into the thousands.

`score`/`raw`/`trustScore` are validated *and* clamped to stay within their documented range ([0, 100]) even under floating-point edge cases. Malformed input — an out-of-range value, a non-ISO date, a negative weight, an unrecognized dial preset, a `NaN` or `Infinity` where a finite number is required — throws a `TypeError` or `RangeError` instead of silently producing a `NaN` or out-of-range score. `EXAMPLE_IDENTIFIED_CONFIG`, `EXAMPLE_ANONYMOUS_CONFIG`, and `TRUST_DIALS` are frozen (including their nested weight maps), and every config `resolveIdentifiedConfig`/`resolveAnonymousConfig` returns is frozen too, so a caller can't accidentally mutate a config object and change every subsequent score in the process.

## Honest limits

- **These are weighted heuristics over the signals you supply, not a measure of truthfulness.** Neither module checks whether any underlying claim, review, or event is actually true — `identified` reflects how much credible, recent, well-sourced *evidence* exists for a score, and `anonymous` reflects how *organic* a pattern of sentiment looks, not whether any individual opinion in it is honest or accurate. A perfectly genuine reviewer can be wrong; a perfectly organic-looking astroturf campaign (see below) can pass.
- **Per-signal and per-corpus only, not cross-signal.** `identified` reputation-weights one contributor at a time; `anonymous` looks for statistical anomalies within one entity's corpus. Neither module correlates behavior *across* entities or contributors — a ring of accounts that each post one plausible, well-spaced, moderately-worded review across many different entities will not be caught here. That's a graph/network-analysis problem, not a per-signal or per-corpus scoring problem, and it's out of scope for this library.
- **The astroturf checks are heuristics, not a detector.** They catch two cheap, common failure modes — evidence concentrated in too few sources, and near-identical near-maximal praise with almost no variance — and nothing else. What they *can* show: this particular corpus looks statistically unusual in one of those two specific ways. What they *cannot* show: that the sentiment is fabricated, that any reviewer is fake, or that a campaign which varies its wording and sentiment (say, keeping values in a plausible 0.5–0.9 range with real-looking spread across several throwaway "sources") isn't there. Authenticity assessment here is a discount applied to a score, not a fraud finding.
- **`identified` trusts its inputs' identity claims.** It assumes `tier`, `source`, `proof`, and `reputation` are already honestly computed upstream (e.g. by your own account/verification system) — this library weights them, it doesn't verify them.
- **Priors and configuration are on you.** Both modules require the caller to supply a sensible domain baseline (`prior`) and weight configuration; a bad prior or miscalibrated weights will produce a confidently wrong score just as fast as a well-calibrated one produces a confidently right one. Validation catches malformed configuration (wrong type, out of range, NaN/Infinity) — it cannot catch a config that is well-formed but wrong for your domain.

## Relationship to sibling kits

trust-core scores *who* or *what pattern of signals* to trust — a contributor, or a corpus of anonymous sentiment about an entity. It does not evaluate whether any specific written claim is corroborated by evidence; for that, see `corroboration-kit`, which grades one claim at a time against the evidence signals collected for it. The two compose naturally (e.g. a claim's evidence signals could themselves be weighted by the credibility of the contributor who supplied them, using `identified`), but trust-core does not depend on or import from it.

## Development

```bash
npm install
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run build      # emits dist/ (ESM + .d.ts)
npm run verify     # lint + typecheck + test + build + verify:package (what CI runs)
```
