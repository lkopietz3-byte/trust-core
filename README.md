# trust-core

**[Try it in your browser →](https://lkopietz3-byte.github.io/honesty-kits/#trust-core)** · Part of [honesty kits](https://github.com/lkopietz3-byte/honesty-kits), a family of small checks for the claims an AI product makes.

Two complementary lenses on entity trust: score signals from contributors you know, and weigh how organic a corpus of anonymous sentiment looks when you don't. Zero runtime dependencies, ESM, framework-agnostic TypeScript. These are configurable weighted-average heuristics over the signals you supply, not a truth detector, a fraud detector, or a certification. See **Honest limits** below before you rely on either module for something adversarial.

## What it is

Any product that ranks or vouches for entities (a stylist directory, a contractor marketplace, a vendor list, a product-review aggregator) ends up needing two different kinds of trust math. `identified/` scores signals from contributors you know: reviewers, raters, inspectors with an account and a history, weighted by their tier, source, proof-of-something, reputation, and recency, then shrunk toward a domain baseline so thin evidence doesn't swing a score. `anonymous/` scores signals from contributors you don't know: scraped mentions, imported reviews, aggregator feeds with no verifiable identity, using source diversity, volume, recency, and consensus, then discounts two patterns its heuristics flag (too few source types, near-uniform praise). Both are pure functions (no I/O, no clock, no randomness beyond what you pass in), so results are deterministic and testable.

## When not to use it

- You need to know whether a review, claim or identity is real. Nothing here checks that; see **Honest limits**.
- You need to detect coordinated campaigns across many entities or accounts. Both modules score one entity's evidence at a time.
- You need calibrated probabilities. The example weights and dials are illustrative, and a score is a weighted heuristic, not a probability.
- You want a fraud or moderation verdict. A discounted pattern is a reason to look, not a decision.

## Why one library, not two

A real product may need both halves at once. It can weight signals from known reviewers by caller-provided attributes and inspect anonymous-source patterns for signs of manipulation. Those are different inputs and different calculations; neither detects every coordinated campaign. Building them as one library, sharing a weight primitive, a recency-decay curve, a shrink-toward-baseline move, and a confidence label, lets a product use both patterns from a single import while keeping their assumptions visible.

## Install

```bash
npm install trust-core
```

Or build from source: clone the repository and run `npm install && npm run build`. The behavior described below includes the changes listed under **Unreleased** in [CHANGELOG.md](CHANGELOG.md); some scores differ from 0.2.1.

This is an ESM package (`"type": "module"`). ESM and CommonJS consumers work like this:

| How you load it | Works on | Notes |
| --- | --- | --- |
| `import` (ESM) | Node 20, 22, 24, 26 | The normal way. |
| `require()` (CommonJS) | Node 20.19+ and 22.12+ (and later) | Uses Node's `require(esm)`. On an older Node, use dynamic `import()`. |
| TypeScript, `moduleResolution` `node10`, `node16`/`nodenext` or `bundler` | TypeScript 5.x | Checked by `attw` and by a consumer probe in CI. |

Node 22 and 24 (LTS) are recommended for production and Node 26 is current. Node 20 is end-of-life: it is tested for compatibility only and gets no upstream security fixes.

## `identified`: score known contributors

```ts
import { identified } from "trust-core";
// or: import { scoreEntity, resolveIdentifiedConfig } from "trust-core/identified";

// Every weight is yours to define: this example is a vendor directory
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
  now: "2026-08-01T00:00:00Z", // a strict ISO 8601 string, or a `Date`
  prior: 55, // the category baseline, e.g. the pooled mean across all vendors
  dial: "balanced", // "as_is" | "balanced" | "strict", or a raw number
});

result.score;       // 64.08: pulled from the 90.45 raw mean toward the 55 prior
result.raw;          // 90.45: unshrunk credibility-weighted mean, or null with no evidence
result.nEff;         // 1.38: effective sample size (sum of signal weights), not a raw count of 2
result.confidence;   // { level: "thin", effectiveSampleSize: 1.38 }: nEff is well below the "moderate" threshold of 3
result.contributions; // per-signal weight breakdown, heaviest first (ties by id, tier, source, proof, then age)
result.signalCount;   // 2: signals submitted
result.eligibleSignalCount; // 2: signals that carried a positive weight
```

This is the actual output of the snippet above, run against the built package: `r1`'s verified/direct/receipt/reputation-85 profile outweighs `r2`'s new/imported/none profile by about 20 to 1, but neither is enough evidence (`nEff` of 1.38, versus a `balanced` dial strength of 4) to move the score far from the 55 prior.

`scoreEntity` validates as it goes: `options` must be an object with a `now`, `value` and `reputation` must be in `[0, 100]` (or `null` for reputation), `occurredAt`/`now` must be a strict ISO 8601 timestamp (`now` also accepts a `Date`), `prior` must be in `[0, 100]`, and `dial` must be a known preset name or a finite number `>= 0`. A signal referencing a `tier`/`source`/`proof` with no configured weight (including a prototype property name like `"constructor"`, which is treated as absent rather than silently resolving to a non-numeric value) throws too. Every one of these throws a `TypeError` (wrong type) or `RangeError` (right type, bad value) instead of letting a bad input quietly turn into a `NaN` or out-of-range score. A signal's fields, the options and the config are each read once and validated as one snapshot, and a sparse array (a hole in `signals`) is rejected, not skipped.

A signal that carries zero weight (a tier, source or proof weighted `0`, or an age that decays it to nothing) contributes nothing to `score`, `raw`, `nEff` or `confidence`. If no signal carries any weight, the result says so plainly instead of reporting a confident-looking number:

```ts
const empty = identified.scoreEntity([], config, { now, prior: 55 });
empty.confidence; // { level: "insufficient", effectiveSampleSize: 0, reason: "no signal has a positive weight, so the score is the prior" }
empty.raw;        // null
empty.score;      // 55: exactly the prior
```

Check `confidence.level === "insufficient"` before you show a score. Equal-weight `contributions` are ordered by `id`, then `tier`, `source`, `proof` and age, so the same signals give the same result in any order.

The trust dial controls how hard a score is pulled toward the prior when evidence is thin:

```ts
const now = "2026-08-01T00:00:00Z"; // pin the clock so the output does not depend on today's date

identified.scoreEntity(signals, config, { now, prior: 55, dial: "as_is" });   // trust the numbers
identified.scoreEntity(signals, config, { now, prior: 55, dial: "balanced" }); // sensible default
identified.scoreEntity(signals, config, { now, prior: 55, dial: "strict" });  // demand deep evidence
identified.scoreEntity(signals, config, { now, prior: 55, dial: 6 });        // or your own C
```

Scoring more than one dimension (quality, reliability, communication) for the same entity: call `scoreEntity` once per dimension, then combine:

```ts
// `now` is the pinned clock from above.
const quality = identified.scoreEntity(qualitySignals, config, { now, prior: 60 });
const reliability = identified.scoreEntity(reliabilitySignals, config, { now, prior: 70 });

const composite = identified.composeDimensions(
  { quality, reliability },
  { quality: 2, reliability: 1 }, // your product's own dimension weights
);
// A weighted average over the measured dimensions, or null when none is measured.

const detail = identified.composeDimensionsDetailed({ quality, reliability }, { quality: 2, reliability: 1 });
detail; // { score, measured: ["quality", ...], unmeasured: [...] }
```

A positively weighted dimension is **unmeasured** when its `confidence.level` is `"insufficient"` or its `nEff` is below 0.25 (a quarter of one reference signal; change it with `composeDimensionsDetailed`'s `minEffectiveSampleSize` option). Its score would be (almost) the bare prior, so it is left out and the remaining weights are renormalized. `composeDimensions` returns `null` only when nothing weighted is measured, never `0` for "no data"; handle `null` before sorting (JavaScript's `<` and `-` treat `null` as `0`). Use `composeDimensionsDetailed` to see which dimensions were left out.

**Dates in the future.** An `occurredAt` up to one day after `now` (clock skew, or a date-only stamp from a zone ahead of UTC) counts as age 0. A date further ahead is not usable as a date: the signal gets the `missingDateAgeDays` age, never full recency, and its `contributions` row shows `ageDays: null`.

**Weight scale.** Weights are on an absolute scale: a weight of 1.0 is one reference signal. `nEff` is the sum of weights, the dial `C` counts phantom signals of weight 1.0, and the confidence thresholds count weight. So multiplying every weight by `k` multiplies `nEff` by `k`, which is exactly the same as dividing the dial and the thresholds by `k`; `raw` does not change. This is deliberate: it is what lets ten weak signals carry less than one strong one. If you think in relative multipliers (new 1, verified 3, expert 5), divide each map by the value you want to count as one signal before you pass it in, or scale `dial` and `confidence` by the same factor.

## `anonymous`: assess authenticity of unattributed signals

```ts
import { anonymous } from "trust-core";
// or: import { assessAuthenticity, resolveAnonymousConfig } from "trust-core/anonymous";

const config = anonymous.resolveAnonymousConfig({
  // "Localness"/credibility per source type: your own taxonomy.
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

verdict.trustScore;   // 70
verdict.components;   // { consensus: 0.83, diversity: 0.48, volume: 0.53, recency: 0.94, astroturfPenalty: 0 }
verdict.flags;         // { lowSourceCount: false, uniformSentiment: false }
verdict.confidence;   // { level: "moderate", effectiveSampleSize: 3 }: 3 distinct source types
verdict.explanation;  // "Heuristic score 70/100 from 3 effective source types (independence not verified). Sentiment is strongly positive."
verdict.signalCount;  // 3: observations submitted
verdict.eligibleSignalCount; // 3: observations that counted (effective weight above 0)
```

This is the actual output of the snippet above, run against the built package: three signals from three different source types with configured credibility, all recently published and positive, with nothing uniform or concentrated enough to trip the astroturf checks. Diversity is 0.48 because the evidence adds up to about 2.9 effective source types of a reference of six (the marketplace post weighs a little under the full-count weight, so it counts as 0.89): three observations do not earn full diversity. The `source` strings are labels you assign; nothing checks that two labels are really two independent publishers.

**Source types.** Labels are compared after trimming and case-folding, so `"forum"`, `"Forum"` and `" forum "` are one source type (in `sourceWeights` keys too; two keys that collide this way with different weights throw a `RangeError`). A source type counts in full once its own effective weight reaches the **full-count weight**: half of one fresh, fully confident observation from the most credible configured source type (0.425 with the example config, so one fresh forum post at confidence 0.9 counts in full), and in proportion below that. `sourceCount` counts the source types that reach at least half of the full-count weight, and is at least 1 when anything is eligible. A near-weightless observation from another source type therefore cannot lift a corpus out of the concentration discount (confidence 0.001 counts as 0.002 of a source type), while one post with real weight on another platform is real evidence and counts. Because a source type's count depends only on its own weight, adding evidence to one source type never makes another count for less, and because the full-count weight is relative to your credibilities, scaling every `sourceWeights` value by the same factor changes nothing. Sums are snapped to whole numbers when floating-point roundoff leaves them a hair off, so a count is never decided by the last bit. Volume and diversity use the unrounded effective count, so neither one moves in steps.

**When the score can drop.** Adding an observation never lowers `trustScore` if its sentiment is at or above the corpus's weighted mean and it is at least as fresh as the corpus on average (for example, published at `now`), whichever source type it comes from, with one exception: it can raise the uniformity discount, because more identical praise is more uniform and the uniformity check starts to apply once there are `minSignalsForUniformCheck` effective observations. An older observation lowers the average recency, and a less positive one lowers consensus, so either of those can lower the score too.

**Duplicates.** Observations are not deduplicated, and `id` is never read: submitting the same review twice counts it twice. Deduplicate upstream.

**Dates in the future.** A `publishedAt` up to one day after `now` counts as age 0. A date further ahead is scored as undated (`missingDateAgeDays`), never as perfectly fresh, and the explanation says how many observations that happened to.

**Eligible evidence.** An observation is eligible only if its final effective weight (source credibility × `confidence` × recency decay) is above 0. The rest are still validated, but they contribute nothing to the score, the components, the flags, `sourceCount` or `confidence`, so adding more of them changes no output except `signalCount`. An unlisted source type has credibility 0, a `confidence` of 0 gives weight 0, and so does an age that has decayed the weight to exactly 0 (`halfLifeDays: 0` with any age above 0, or a date so old the weight underflows). An age that only lowers the weight, leaving it above 0, does not make an observation ineligible.

If nothing is eligible, the result is explicit:

```ts
const ignored = anonymous.assessAuthenticity(
  [{ id: "z1", source: "forum", sentiment: 0.9, confidence: 0, publishedAt: "2026-07-01T00:00:00Z" }],
  config,
  { now: "2026-08-01T00:00:00Z" },
);
ignored.confidence;          // { level: "insufficient", effectiveSampleSize: 0, reason: "no observation has a positive effective weight (confidence, source credibility and recency decay must all be above 0)" }
ignored.trustScore;          // null: no usable evidence, so no score (not a low score)
ignored.eligibleSignalCount; // 0
ignored.signalCount;         // 1
ignored.explanation;         // "Insufficient evidence: no observation has a positive effective weight ... so no score is reported."
```

`trustScore` is `null` exactly when `confidence.level` is `"insufficient"`, so handle `null` wherever you show or sort it. `null` is not a low score: JavaScript's `<`, `-` and `Math.min` treat it as `0`, so sorting without a special case ranks an entity nobody has said anything about as the least trustworthy.

The astroturf penalty fires on either of two conditions, and either is enough to discount the score:

- **Concentration**: the eligible evidence comes from too few source types. The full `concentrationPenalty` applies at or under `concentrationSourceCeiling` effective source types and ramps linearly to 0 one source type above it. It applies at any observation count: one review from one source type is as concentrated as thirty, so the discount does not switch on as reviews accumulate, and more reviews never make it larger.
- **Uniformity**: weighted sentiment is near-maximal with near-zero weighted variance (`mean > uniformMeanThreshold && variance < uniformVarianceThreshold`), from `minSignalsForUniformCheck` effective observations up (a near-weightless observation does not count toward that minimum). The mean and variance use the same weights as consensus, so a near-weightless outlier cannot move them. The discount is `uniformPenalty` times how far the mean is past its threshold, reaching full at 0.05 past it, times the square of how far the variance is below its threshold. It starts at 0 on each threshold, so there is no cliff, and with the example threshold of 0.85, identical praise from 0.9 up gets the full penalty. An honest set with real spread is barely touched (the 4.92-star fixture in the verdict table, 23 five-star and 2 four-star reviews, ranks above the 4.60-star one), but identical ratings are discounted whatever their level: 40 identical 4.92-star ratings rank below 40 identical 4.60-star ones, because 4.60 stars (0.8) is under the threshold. Copied or purchased praise can look like this, and so can a genuinely enthusiastic audience, so the explanation reports it as a pattern, not as a finding.

A flag is `true` exactly when its discount is above 0. Both checks look at eligible observations only. The explanation text describes patterns and uncertainty, never fraud, verified independence, or an age the data does not support.

`assessAuthenticity` validates as it goes: `options` must be an object with a `now`, `sentiment` must be in `[-1, 1]`, `confidence` in `[0, 1]`, and `publishedAt`/`now` must be a strict ISO 8601 timestamp (`now` also accepts a `Date`). A signal's `source` with no configured weight (including a prototype property name like `"constructor"`) has the documented `0` credibility, so its observations are ineligible (see above) rather than resolving to a non-numeric value. Every validation failure throws a `TypeError` or `RangeError` instead of letting a bad input quietly corrupt `trustScore`.

The four `weights` (`consensus`/`diversity`/`volume`/`recency`) do **not** need to sum to 1 and are **not** normalized: they're used exactly as given in the weighted sum, so halving every weight halves the pre-penalty composite rather than leaving `trustScore` unchanged. Summing to 1 is just what keeps the composite intuitively readable as a 0-100 scale; it isn't enforced. The composite is capped at 1 **before** the astroturf discount is subtracted, so weights that sum above 1 saturate the score instead of absorbing the discount.

Inputs are not rescaled. A 1-5 star rating passed as `value: 5` reads as 5 out of 100, and a model score in `[0, 1]` passed as `sentiment` reads as neutral-to-positive on the `[-1, 1]` scale. Map your scale first (for stars, `(stars - 3) / 2` for sentiment or `(stars - 1) * 25` for a value).

## The shared toolkit

`src/shared/types.ts` holds the primitives both modules are built from, so they read as one system rather than two unrelated files bundled together:

- `clamp` / `clamp01`: bound a number into a range / into `[0, 1]`.
- `Weight`: the shared type alias for a signal's credibility multiplier.
- `recencyDecay(ageDays, halfLifeDays)` / `daysBetween(fromISO, toISO)`: the exponential decay curve both modules use, one for "time since the event happened," one for "time since the material was published."
- `shrinkTowardPrior(weightedSum, totalWeight, prior, dial)`: pull a weighted mean toward a baseline by a configurable strength, measured in signals of weight 1.0.
- `TRUST_DIALS` / `TrustDialPreset` / `resolveDial`: the named `as_is` (`C` = 0.5) / `balanced` (`C` = 4) / `strict` (`C` = 12) shrinkage presets, and a resolver that also accepts a raw number. `C` is the number of "phantom prior signals" mixed in before the real evidence; the object is deep-frozen and the values are illustrative, not calibrated for any domain. A dial must be a preset name or a number; anything else (an array, a `String` object, `null`) is a `TypeError`, never coerced into a name.
- `confidenceFromSampleSize(n, thresholds)`: the `high` / `moderate` / `thin` confidence label, derived from an effective sample size (signal weight sum for `identified`, the counted source types, `sourceCount`, for `anonymous`). A sample size of exactly `0` is `"insufficient"`, with a `reason`, whatever the thresholds are.

## API reference

Every export, by entry point (`src/index.ts` re-exports `shared` and adds the `identified` and `anonymous` namespaces):

| Entry point | Export | What it is |
| --- | --- | --- |
| `trust-core/identified` | `scoreEntity(signals, config, options)` | Score one entity or dimension from known contributors. Returns `EntityScore`. |
| | `resolveIdentifiedConfig(overrides?)` | Merge a partial override over the example config, validate, deep-freeze. |
| | `EXAMPLE_IDENTIFIED_CONFIG` | An illustrative, frozen starting configuration. |
| | `composeDimensions(scores, weights)` | Weighted average of several `EntityScore`s over the measured dimensions, or `null` when none is measured. Excludes missing and non-positive weights. |
| | `composeDimensionsDetailed(scores, weights, options?)` | The same composite, plus which dimensions were `measured` and `unmeasured`. |
| | `signalWeight(signal, config, asOf)` | The weight of one signal. |
| | `signalAgeDays(occurredAt, asOf, recency)` | A signal's age in days, or the configured fallback. |
| | `reputationFactor(reputation, curve)` | The multiplier for a 0-100 reputation (or `null`). |
| | `TRUST_DIALS`, `TrustDial`, `TrustDialPreset` | Re-exported from `shared`. |
| `trust-core/anonymous` | `assessAuthenticity(signals, config, options)` | Gauge how organic a corpus looks. Returns `AuthenticityAssessment`. |
| | `resolveAnonymousConfig(overrides?)` | Merge, validate, deep-freeze. |
| | `EXAMPLE_ANONYMOUS_CONFIG` | An illustrative, frozen starting configuration. |
| `trust-core/shared` | `clamp`, `clamp01` | Bound a number. `NaN` passes through. |
| | `daysBetween(fromISO, toISO)` | Fractional days between two strict ISO timestamps. |
| | `recencyDecay(ageDays, halfLifeDays)` | The exponential decay multiplier. |
| | `shrinkTowardPrior(weightedSum, totalWeight, prior, dial)` | Pull a weighted mean toward a baseline. |
| | `TRUST_DIALS`, `resolveDial(dial)` | The `as_is` / `balanced` / `strict` presets and their resolver. |
| | `confidenceFromSampleSize(n, thresholds)` | The confidence label for a sample size. |
| | Types: `Weight`, `TrustDial`, `TrustDialPreset`, `ConfidenceLevel`, `ConfidenceThresholds`, `Confidence` | |

The signal, config, options and result types are exported from the entry point that uses them (`IdentifiedSignal`, `IdentifiedConfig`, `EntityScore`, `AnonymousSignal`, `AuthenticityAssessment`, and so on).

## Determinism, validation, and immutability

Both `scoreEntity` and `assessAuthenticity` are pure functions: no `Date.now()`, no `Math.random()`, no I/O. Given the same arguments they return the exact same result, including in the last bit: every internal sum (signal weights, weighted values, consensus/recency accumulators) uses an order-independent, correctly-rounded summation algorithm, so the result does not depend on what order you list your signals in and does not drift as the count grows into the thousands.

`score`/`raw`/`trustScore` are validated *and* clamped to stay within their documented range ([0, 100]) even under floating-point edge cases. Malformed input (an out-of-range value, a non-ISO date, a negative weight, an unrecognized dial preset, a `NaN` or `Infinity` where a finite number is required) throws a `TypeError` or `RangeError` instead of silently producing a `NaN` or out-of-range score. So does a value derived from valid inputs that overflows double precision (two `Number.MAX_VALUE` weights multiplied, or a dial so large that `dial * prior` overflows): it is a `RangeError`, never `NaN`, `Infinity`, or a result the clamp has quietly turned into `100`.

Configuration follows one rule: only `undefined` means "use the defaults". `resolveIdentifiedConfig()` and `resolveAnonymousConfig()` accept `undefined` or a plain object (an object literal, `JSON.parse` output, or a null-prototype object); `null`, `false`, `0`, `""`, `NaN`, an array, a `Date`, a `Map` or a class instance, at the top level or in any section, is a `TypeError`. Each section is checked before it is merged.

Error messages that quote a caller's string (a tier name, a config key) escape control, line-separator and bidi/format characters, so a hostile string cannot forge a second line or drive a terminal. `EXAMPLE_IDENTIFIED_CONFIG`, `EXAMPLE_ANONYMOUS_CONFIG`, and `TRUST_DIALS` are frozen (including their nested weight maps), and every config `resolveIdentifiedConfig`/`resolveAnonymousConfig` returns is frozen too, so a caller can't accidentally mutate a config object and change every subsequent score in the process.

## Honest limits

- **These are weighted heuristics over the signals you supply, not a measure of truthfulness.** Neither module checks whether any underlying claim, review, or event is actually true. `identified` reflects how much credible, recent, well-sourced *evidence* exists for a score, and `anonymous` reflects how *organic* a pattern of sentiment looks, not whether any individual opinion in it is honest or accurate. A perfectly genuine reviewer can be wrong; a perfectly organic-looking astroturf campaign (see below) can pass.
- **Per-signal and per-corpus only, not cross-signal.** `identified` reputation-weights one contributor at a time; `anonymous` looks for statistical anomalies within one entity's corpus. Neither module correlates behavior *across* entities or contributors: a ring of accounts that each post one plausible, well-spaced, moderately-worded review across many different entities will not be caught here. That's a graph/network-analysis problem, not a per-signal or per-corpus scoring problem, and it's out of scope for this library.
- **Labels are not identities.** `source` is a string you assign, and `sourceCount` counts source types by their own effective weight. Nothing here checks that two labels are two independent publishers, or that one label is not many accounts. The result says "independence not verified" for that reason.
- **`trustScore` is not a sentiment ranking.** It blends sentiment with the pattern discounts, so a discounted positive corpus (thirty posts from one forum) can rank below an undiscounted negative one (a review bomb spread over four source types). The uniformity check looks for near-maximal praise only; it does not discount uniform negative sentiment.
- **Concentration is a shape, not a motive.** One review, or a product that is popular on one platform with only a faint mention elsewhere, reads as concentrated and is discounted (with `confidence.level` of `"thin"`). That is what the evidence looks like, not a judgment about why. Volume within one source type does not count toward breadth, so a single honest post can score at or below thirty posts from one platform that carry the full concentration discount; both read as one source type.
- **A number is not a finding.** `trustScore` and the explanation describe a pattern in the numbers you supplied. With no usable evidence, `trustScore` is `null` rather than a number, so an entity nobody has said anything useful about is never ranked as if it had been measured as untrustworthy.
- **The astroturf checks are heuristics, not a detector.** They catch two cheap, common failure modes (evidence concentrated in too few sources, and near-identical near-maximal praise with almost no variance) and nothing else. What they *can* show: this particular corpus looks statistically unusual in one of those two specific ways. What they *cannot* show: that the sentiment is fabricated, that any reviewer is fake, or that a campaign which varies its wording and sentiment (say, keeping values in a plausible 0.5–0.9 range with real-looking spread across several throwaway "sources") isn't there. The bar is low on purpose and easy to clear: one post with real weight on each extra source type clears the concentration discount, however large the rest of the corpus, and one real dissenting review (or about 1% of the weight far from the mean) clears the uniformity discount. Authenticity assessment here is a discount applied to a score, not a fraud finding.
- **`identified` trusts its inputs' identity claims.** It assumes `tier`, `source`, `proof`, and `reputation` are already honestly computed upstream (e.g. by your own account/verification system): this library weights them, it doesn't verify them.
- **Priors and configuration are on you.** Both modules require the caller to supply a sensible domain baseline (`prior`) and weight configuration; a bad prior or miscalibrated weights will produce a confidently wrong score just as fast as a well-calibrated one produces a confidently right one. Validation catches malformed configuration (wrong type, out of range, NaN/Infinity); it cannot catch a config that is well-formed but wrong for your domain, a weight map on a different scale than the dial and thresholds (see **Weight scale**), or values on the wrong scale (a 1-5 rating passed as a 0-100 value).

## Relationship to sibling kits

trust-core scores *who* or *what pattern of signals* to trust: a contributor, or a corpus of anonymous sentiment about an entity. It does not evaluate whether any specific written claim is corroborated by evidence; for that, see [`corroboration-kit`](https://github.com/lkopietz3-byte/corroboration-kit), which grades one claim at a time against the evidence signals collected for it. The two compose naturally (e.g. a claim's evidence signals could themselves be weighted by the credibility of the contributor who supplied them, using `identified`), but trust-core does not depend on or import from it.

Both `scoreEntity`'s and `assessAuthenticity`'s clock option is named `now` (accepting a strict ISO 8601 string or a `Date`), matching [`claims-registry-kit`](https://github.com/lkopietz3-byte/claims-registry-kit) and [`freshness-kit`](https://github.com/lkopietz3-byte/freshness-kit). Earlier versions of this README called `identified`'s option `asOf`; it was renamed before the first publish for consistency across both modules and the sibling kits above.

## Development

```bash
npm install
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run build      # emits dist/ (ESM + .d.ts)
npm run verify     # lint + typecheck + test + build + verify:package
npm run attw       # are-the-types-wrong check on the packed tarball
npm run audit:dependencies
```
