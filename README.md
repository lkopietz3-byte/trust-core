# trust-core

Two complementary lenses on entity trust: score who you know, and detect who's faking it when you don't. Zero runtime dependencies, ESM, framework-agnostic TypeScript.

## What it is

Any product that ranks or vouches for entities — a stylist directory, a contractor marketplace, a vendor list, a product-review aggregator — ends up needing two different kinds of trust math. `identified/` scores signals from contributors you know: reviewers, raters, inspectors with an account and a history, weighted by their tier, source, proof-of-something, reputation, and recency, then shrunk toward a domain baseline so thin evidence doesn't swing a score. `anonymous/` assesses signals from contributors you don't know: scraped mentions, imported reviews, aggregator feeds with no verifiable identity, scored for source diversity, volume, recency, and consensus, then discounted when the evidence looks planted rather than organic. Both are pure functions — no I/O, no clock, no randomness beyond what you pass in — so results are deterministic and testable.

## Why one library, not two

A real product almost always needs both halves at once. You trust your known reviewers (weighted by their track record) *and* you need to catch astroturf from anonymous sources (weighted by whether the pattern of praise looks organic) — they are not the same problem, and conflating them either lets manipulation through your reviewer pipeline or drowns your best-informed contributors' judgment in statistical noise from a corpus with no identities attached. Building them as one library — sharing a weight primitive, a recency-decay curve, a shrink-toward-baseline move, and a confidence label — means a new product picks up both patterns from a single import instead of re-deriving one of them from scratch, and the two stay legibly related instead of drifting into incompatible conventions over time.

## Install

```bash
npm install trust-core
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

result.score;       // 0-100, shrunk toward the prior by the dial
result.raw;          // 0-100 unshrunk credibility-weighted mean, or null
result.nEff;         // effective sample size (sum of signal weights)
result.confidence;   // { level: "high" | "moderate" | "thin", effectiveSampleSize }
result.contributions; // per-signal weight breakdown, heaviest first
```

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

verdict.trustScore;   // 0-100
verdict.components;   // { consensus, diversity, volume, recency, astroturfPenalty }
verdict.flags;         // { lowSourceCount, uniformSentiment }
verdict.confidence;   // derived from independent source count
verdict.explanation;  // plain-English summary, safe to show a user
```

The astroturf penalty fires on either of two conditions, and either is enough to discount the score:

- **Concentration** — the evidence comes from too few independent sources (`sourceCount <= concentrationSourceCeiling`).
- **Uniformity** — sentiment is near-maximal with near-zero variance (`mean > uniformMeanThreshold && variance < uniformVarianceThreshold`) — no organic dissent, the fingerprint of copy-pasted or purchased praise.

## The shared toolkit

`src/shared/types.ts` holds the primitives both modules are built from, so they read as one system rather than two unrelated files bundled together:

- `clamp` / `clamp01` — bound a number into a range / into `[0, 1]`.
- `Weight` — the shared type alias for a signal's credibility multiplier.
- `recencyDecay(ageDays, halfLifeDays)` / `daysBetween(fromISO, toISO)` — the exponential decay curve both modules use, one for "time since the event happened," one for "time since the material was published."
- `shrinkTowardPrior(weightedSum, totalWeight, prior, dial)` — pull a weighted mean toward a baseline by a configurable strength.
- `TRUST_DIALS` / `TrustDialPreset` / `resolveDial` — the named `as_is` / `balanced` / `strict` shrinkage presets, and a resolver that also accepts a raw number.
- `confidenceFromSampleSize(n, thresholds)` — the `high` / `moderate` / `thin` confidence label, derived from an effective sample size (signal weight sum for `identified`, independent source count for `anonymous`).

## Honest limits

- **Per-signal and per-corpus only, not cross-signal.** `identified` reputation-weights one contributor at a time; `anonymous` looks for statistical anomalies within one entity's corpus. Neither module correlates behavior *across* entities or contributors — a ring of accounts that each post one plausible, well-spaced, moderately-worded review across many different entities will not be caught here. That's a graph/network-analysis problem, not a per-signal or per-corpus scoring problem, and it's out of scope for this library.
- **The uniform-sentiment check is a heuristic, not a detector.** It catches the cheap, common failure mode — near-identical, near-maximal praise with almost no variance. A patient, well-resourced astroturf campaign that varies its wording and sentiment (say, keeping values in a plausible 0.5–0.9 range with real-looking spread) will not trip the `uniformSentiment` flag, and may not trip `lowSourceCount` either if it's spread across several throwaway "sources." Authenticity assessment here is a discount, not a guarantee.
- **`identified` trusts its inputs' identity claims.** It assumes `tier`, `source`, `proof`, and `reputation` are already honestly computed upstream (e.g. by your own account/verification system) — this library weights them, it doesn't verify them.
- **Priors and configuration are on you.** Both modules require the caller to supply a sensible domain baseline (`prior`) and weight configuration; a bad prior or miscalibrated weights will produce a confidently wrong score just as fast as a well-calibrated one produces a confidently right one.

## Development

```bash
npm install
npm test        # vitest run
npm run typecheck  # tsc --noEmit
npm run build      # emits dist/ (ESM + .d.ts)
```
