# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
`0.1.0` was published to npm on 2026-09-28. While the version is 0.x, a change that
makes a previously accepted input throw or return a different result bumps the minor version.

## [Unreleased]

A fix pass from a verdict hunt on realistic review sets, plus three rounds of independent
review. Anonymous scores change for many corpora, `composeDimensions` returns
`number | null`, and future-dated evidence is scored differently. `composeDimensions`'s
return type is a breaking API change, so **the next release must be 0.3.0**. Not released
yet.

### Fixed

- **More confirming anonymous reviews no longer lower the score.** One forum review scored
  81, two scored 68, three 43; one review outranked thirty reviews over three source types.
  The causes, all fixed:
  - `diversity` divided by the observation count (`sourceCount / min(n, 6)`), so a single
    observation got full diversity and every confirming observation lowered it. It is now
    the effective source-type count over a fixed reference of six.
  - The `minSignalsForUniformCheck` gate also skipped the concentration check, so the
    concentration discount switched on at the third review. The gate now applies to the
    uniformity check only; concentration applies at any count.
  - Source labels that differ only in case or surrounding spaces (`"Forum"`, `" forum"`)
    were unlisted sources with weight 0. Labels, in signals and in `sourceWeights` keys, are
    now compared trimmed and case-folded.
  - A source type now counts by its own effective weight, never by its share of the total,
    so piling up reviews on one platform cannot make another platform count for less. With
    a share-based count (an intermediate version of this fix), one aggregator post plus 40
    forum posts scored 42 against 63 for one plus 8; it now scores the same at every size.
    In a 3,000-case seeded fuzz of same-type confirming additions, the score went down 771
    times on 0.2.0 and 121 times now, and every remaining case is the uniformity discount
    rising (more identical praise is more uniform).
- **A near-weightless decoy no longer defeats the discounts.** One extra observation with
  confidence 0.001 from a second source type lifted a 30-post single-forum corpus from 38 to
  67, and three near-weightless dissenting observations cleared the uniformity discount on
  20 identical 5-star reviews (70 to 84). A source type counts in full only once its summed
  credibility x confidence reaches the new `fullCountWeight` setting (default 0.425), in
  proportion below that, and the uniformity mean and variance use the same weights as
  consensus. Both now score 38 and 71.
- **Breadth does not depend on age.** Source types are counted on credibility x confidence
  without recency decay, so old or undated honest mentions count for breadth like fresh
  ones (their age still lowers `recency`). Six platforms with one 3-year-old post each:
  76 on 0.2.0, 49 in an intermediate version of this fix, 75 now; 40 marketplace reviews
  plus one old mention on each of five other platforms: 86, 77, 85. A ring's fresh
  decoys gain nothing from this (it scores 90 either way).
- **Unused source types in the config no longer change scores.** The full-count weight was
  derived from the largest credibility in `sourceWeights`, so adding an unused
  `verified: 2.0` key dropped four fresh posts on four platforms from 76 to 65. It is now
  the explicit `fullCountWeight` setting.
- **No uniformity cliff, and no free pass just above it.** The uniformity discount switched
  fully on at `mean > 0.85 && variance < 0.02`, so 4.92 stars (23 five-star and 2 four-star
  reviews) scored 68 against 78 for 4.60 stars. It now ramps in linearly over 0.05 of mean
  past the threshold and with the square of the variance margin: that 4.92-star set scores
  82, and identical praise at 0.9 or above still gets the full discount (40 identical posts
  at 0.9 over six source types score 78, as on 0.2.0, below an honest J-shaped set at 87).
- **Weights summing above 1 no longer absorb the discount.** The positive composite was
  clamped after the penalty was subtracted, so with weights summing to 2.0 a flagged corpus
  still scored 100. It is now capped at 1 before the discount (86), as the README's "either
  is enough to discount the score" promised.
- **Future-dated evidence no longer gets full recency.** A `publishedAt` or `occurredAt` in
  2099 counted as age 0. A date more than one day after `now` is now scored with
  `missingDateAgeDays`, like a missing date. Up to one day ahead (clock skew, a date-only
  stamp from a zone ahead of UTC) still counts as age 0.
- **`composeDimensions` no longer presents a bare prior as measured.** A dimension with no
  evidence (`score` equal to the prior) was averaged in as if measured, and no positive
  weight returned `0`. Each dimension's weight is now scaled by `min(1, nEff / 0.25)`, so a
  near-bare dimension counts for little and its influence grows smoothly (an intermediate
  version dropped dimensions below 0.25 outright, so a second confirming review moved a
  composite from 82.71 to 79.22 in one step).
- **Flags tell the truth.** With `concentrationPenalty: 0`, a single observation reported
  `lowSourceCount: true` and an explanation claiming concentration lowered the score; each
  flag is now true exactly when its discount is above 0.
- **Roundoff no longer decides a source count.** An effective count of
  `1.9999999999999998` was floored, dropping a source type and flagging concentration.
  Near-integer sums are snapped first.
- **Overriding a shipped source type with a case variant works.**
  `resolveAnonymousConfig({ sourceWeights: { Forum: 1 } })` threw because the default
  `forum` was kept; an override key now replaces the default with the same normalized label.
- The uniformity minimum counts effective observations, so a near-weightless third post no
  longer opens the uniformity check on two real reviews.
- The explanation now includes the concentration sentence when both flags fire.

### Changed (behavior)

These scores move on the example configuration. Anyone who stores, thresholds or ranks
`trustScore` or `composeDimensions` output will see them.

- **Small anonymous corpora score lower.** With fewer than six eligible observations,
  `diversity` used to be inflated by the small count. Three reviews from three source types
  (the README example) went from 83 to 70; two reviews from two source types from 84 to 68.
- **Single-source anonymous corpora of one or two observations are discounted.** One
  marketplace review went from 85 to 43 (`lowSourceCount: true`, `confidence` `"thin"`).
  It is as concentrated as thirty reviews from one source type, which were already
  discounted.
- **Source types count by their own weight.** One post with real weight on another platform
  counts in full (a 30-post forum ring plus one real blog post still scores 67, as on
  0.2.0); a faint one counts in proportion (five posts at confidence 0.12 on five other
  platforms: 90 on 0.2.0, 60 now). `sourceCount` counts source types that reach half of the
  full-count weight, so it can be lower than the number of distinct labels (and
  `confidence.effectiveSampleSize` with it). `lowSourceCount` is true exactly when the
  (ramped) concentration discount is above 0.
- **The uniformity discount is smaller just past its mean threshold** (identical 0.86: 67 on
  0.2.0, 78 now) and full from 0.05 past it. `uniformSentiment` fires on the same
  thresholds, now on the weighted mean and variance, and from `minSignalsForUniformCheck`
  effective observations.
- **Future-dated evidence weighs less.** In `identified`, such a signal's `contributions`
  row has `ageDays: null`, and `signalAgeDays` returns `missingDateAgeDays` for it. In
  `anonymous`, the explanation adds "N observation(s) dated after the assessment time ... scored
  as undated."
- **`composeDimensions` returns `number | null` (breaking).** It scales each positively
  weighted dimension's weight by `min(1, nEff / 0.25)`, gives `"insufficient"` dimensions
  weight 0, renormalizes, and returns `null` only when no weighted dimension is measured (it
  returned `0`). It now reads each dimension's `nEff` and `confidence.level` and throws if
  either is missing or invalid. A dimension left out changes what the composite averages,
  so a vendor with no reliability data can outrank one measured as mediocre.
- **New: `composeDimensionsDetailed(scores, weights, options?)`** returns
  `{ score, measured, unmeasured }`, with a `minEffectiveSampleSize` option.
- **New config field: `fullCountWeight`** (optional; `undefined` selects 0.425). It is on the
  same scale as `sourceWeights` x `confidence`.
- A `sourceWeights` map with two keys that are the same source type after trimming and
  case-folding, with different weights, now throws `RangeError`.
- Explanation text: `from N distinct source types` is now `from N effective source types`,
  and `Few distinct source types relative to the number of observations; treat as uncertain.`
  is now `The evidence spans few distinct source types; treat as uncertain.`
- Unchanged: the `identified` score, `raw`, `nEff` and confidence for any dated-in-the-past or
  undated evidence; the README `identified` example; every config field.

### Documented

- **Identified weight scale.** Confidence and shrinkage depend on the absolute scale of the
  weights (1.0 is one reference signal), so multiplying every weight by `k` is the same as
  dividing the dial and the confidence thresholds by `k`. This is deliberate and now
  documented under "Weight scale" in the README, with a property test; making it
  scale-free would remove the meaning of "ten weak signals carry less than one strong one".
- **When an anonymous score can drop**, exactly: adding an observation at or above the
  weighted mean sentiment and at least as fresh as the corpus average never lowers
  `trustScore`, from any source type, except by raising the uniformity discount.
- `trustScore` is `null` with no evidence, and `null` is not sortable as a number: the doc
  comment used to say it could be sorted without a special case.
- Observations are not deduplicated (`id` is never read); resubmitting a review counts it
  twice.
- Low but nonzero variance is discounted lightly (the variance term is squared): praise
  alternating 0.8 and 1.0 scores 88 against 78 for identical 0.9. A linear variance term
  would close the gap but would push honest near-perfect sets below 4.60-star sets, so it
  is left as a documented gap.
- Inputs are not rescaled: a 1-5 rating passed as a 0-100 `value`, or a `[0, 1]` model score
  passed as a `[-1, 1]` sentiment, is accepted and read on the wrong scale.
- Honest limits say plainly how easy the discounts are to clear: one post with real weight
  on each extra source type clears concentration, and one real dissenting review (or about
  1% of the weight far from the mean) clears uniformity. `trustScore` is not a sentiment
  ranking: a discounted positive corpus can rank below a review bomb, and a single honest
  post can score at or below a fully discounted single-platform set. Identical ratings are
  discounted at any level past the threshold, so 40 identical 4.92-star ratings rank below
  40 identical 4.60-star ones.
- `src/verdict-table.test.ts` pins named review sets (organic, enthusiastic, mixed, ring, bot,
  bomb, decoys, label variants, future dates, both review rounds) with their flags,
  ordering and confidence, plus seeded property tests for monotonicity, order independence
  and weight scale. `api-surface.json` adds `composeDimensionsDetailed`.

## [0.2.1] - 2026-10-07

No change to the library's behavior or API.

### Changed

- The README links to the [in-browser playground](https://lkopietz3-byte.github.io/honesty-kits/#trust-core) and the honesty kits family, and the npm homepage now points to the playground.
- Added the `honesty-kits` npm keyword so the family shows up together in search.

### Security

- Development lockfile: `source-map-js` 1.2.2 (GHSA-68fv-2mgg-jv7q). Development tooling only; the published package has no runtime dependencies.

## [0.2.0] - 2026-09-28

A fix pass from an external audit and an internal one. Several inputs that used to be
accepted now throw, and several results are different, so this is a minor bump. Findings
are labeled TC-nnn (the external audit) or by bug class (the internal sweep).

### Changed (previously accepted input now throws or returns a different result)

- **Overflow and `NaN` are errors (TC-001).** A weight product, weighted value, sum, or
  shrinkage term that is not finite throws `RangeError`. Before, two large finite weights
  returned `NaN` and `Infinity`, and a huge dial returned a score clamped to `100`.
  `exactSum` rejects a lone non-finite term. `shrinkTowardPrior`, `recencyDecay`,
  `daysBetween` and `confidenceFromSampleSize` validate their arguments (a `NaN`, a
  negative `totalWeight` or `dial`, a zone-less or malformed timestamp) instead of returning
  `NaN` or a label. `composeDimensions` validates each dimension's `score` (finite, 0-100).
- **Only `undefined` means "use the defaults" (TC-002).** `resolveIdentifiedConfig` and
  `resolveAnonymousConfig` used to treat `null`, `false`, `0`, `""` and `NaN` as "no
  overrides" and spread malformed sections (`false`, `0`, `null`, an array, a `Date`) into the
  defaults. They now throw `TypeError`; every section is validated before it is merged, a
  `null` `astroturfWeight` or `volumeSaturation` is an error, and a `null` `dial` is an error.
  Records must be plain objects or null-prototype objects (a `Map` or class instance is
  rejected).
- **`scoreEntity`, `signalWeight` and `assessAuthenticity` validate the config they are
  given**, reading it once. A hand-built config with a `NaN` weight, a typo key, or a missing
  section now throws.
- **An unknown tier, source or proof is a `RangeError`** (it was a bare `Error`), as
  documented.
- **Zero-weight evidence contributes nothing (TC-003).** In `anonymous`, an observation with
  `confidence` 0, an unlisted source type, or a source type configured with credibility 0 no
  longer counts toward `sourceCount`, diversity, volume, the uniformity checks, or
  confidence. Six such observations used to read as `high` confidence with a score of 60 to 75.
  The same holds for an observation whose age has decayed its weight to exactly 0 (`halfLifeDays: 0`,
  or a date so old the weight underflows): eligibility is decided by the final effective weight
  (credibility x confidence x recency decay), which must be above 0. Before, such an observation
  still counted, raised `sourceCount`, diversity and confidence, and, when every weight was 0, fell
  back to a neutral consensus of 0.5. Six all-negative reviews with a 7-day half-life dated 2001 scored
  60 with `high` confidence and outranked the same reviews all-positive at 46; both are now
  `"insufficient"` with `trustScore: null`. `identified` already required a positive weight and is unchanged.
- **No eligible evidence is `"insufficient"` (TC-003).** `ConfidenceLevel` gains
  `"insufficient"`, and `Confidence` gains an optional `reason`. `confidenceFromSampleSize(0, ...)`
  returns it whatever the thresholds are (a zero threshold used to give `high`). In `identified`,
  `raw` is `null` and `score` is exactly `prior` (it used to differ in the last bit for some dials).
  In `anonymous`, `trustScore` is `null` (its type is now `number | null`), every component is `0`, both flags are `false`. A score of `0` would have read as "least trustworthy" and sorted an entity with no evidence below one that looks planted.
- **Explanations describe patterns only (TC-004).** Changed strings in
  `assessAuthenticity().explanation`:
  - `Trust 83/100 across 3 independent sources.` is now
    `Heuristic score 83/100 from 3 distinct source types (independence not verified).`
  - `Evidence leans on very few sources — treat as provisional.` is now
    `Few distinct source types relative to the number of observations; treat as uncertain.`
  - `Most evidence is dated.` is now
    `Recency is low given the publication dates supplied; observations without a date use the configured default age.`
    or, when no observation has a date,
    `No publication dates were supplied, so recency reflects only the configured default age and is uncertain.`
  - `Sentiment is suspiciously uniform; discounted as likely planted.` is now
    `Sentiment is unusually uniform, which lowers the score. This is a pattern in the numbers, not a finding about the observations.`
  - `Backed by very few independent sources; discounted.` is now
    `Evidence comes from very few distinct source types, which lowers the score.`
  - New: `Insufficient evidence: no observation has a positive effective weight (confidence, source credibility and recency decay must all be above 0), so no score is reported.`
  - Unchanged: `Sentiment is strongly positive.` and `Sentiment is lukewarm or negative.`
- **A `dial` must be a preset name or a number.** An array, a `String` object, or `null` used
  to be coerced into a preset name or defaulted; it is now a `TypeError`.
- **Sparse `signals` arrays throw `TypeError`** naming the hole, instead of a native error or a
  partial result. Each signal, options and config field is read once.
- **`daysBetween` uses the strict timestamp grammar** (`YYYY-MM-DD`, or a date-time with `Z` or
  `+HH:MM`); a zone-less string is rejected instead of read in the process's local zone.

### Added

- `eligibleSignalCount` on `EntityScore` and `AuthenticityAssessment`; `signalCount` is still
  the number submitted.
- Stable order for equal-weight `contributions`: id, tier, source, proof, then age (TC-006).
- `typesVersions`, so `trust-core/identified`, `/anonymous` and `/shared` resolve under legacy
  `moduleResolution: node`. `npm run attw` no longer needs `--profile node16`.
- TSDoc for every export, including `TRUST_DIALS`.
- Error messages escape control, line-separator and bidi/format characters from caller strings.

### Internal

- Release workflow: a `v*` tag is required on both triggers; it runs the dependency audit,
  `verify` and `attw`; only a confirmed `E404` means "not published". The compatibility job
  pins Node 20.19.0 and 22.12.0.
- Tests: 120 to 479 tests, 100% line and branch coverage, mutation score 57.2% to 99.0%.

## [0.1.0] - 2026-09-27

First release. Deterministic, zero-runtime-dependency TypeScript scoring
primitives for entity trust:

- `identified` — score entities from known, identified contributors: a
  credibility-weighted mean (tier x source x proof x reputation x recency),
  shrunk toward a caller-supplied domain baseline (`prior`) by a configurable
  dial, with a confidence label derived from the effective sample size.
- `anonymous` — assess how authentic a corpus of unattributed signals looks,
  from source diversity, volume, recency, and consensus, discounted when the
  evidence looks concentrated in too few sources or suspiciously uniform.
- `shared` — the weight, recency-decay, shrinkage, and confidence primitives
  both modules are built from.
- Every public function validates its inputs and throws a `TypeError` or
  `RangeError` on a malformed value (out of range, wrong type, `NaN`,
  `Infinity`, an unknown config key, a prototype-chain lookup key) instead of
  silently producing a `NaN` or out-of-range score. `score`/`raw`/`trustScore`
  are also clamped to their documented `[0, 100]` range as a final safety net.
- All internal summation is order-independent and correctly rounded
  (Shewchuk/`fsum`-style compensated summation), so results do not depend on
  the order signals are given in and do not drift as the count grows.
- `EXAMPLE_IDENTIFIED_CONFIG`, `EXAMPLE_ANONYMOUS_CONFIG`, and `TRUST_DIALS`
  are deep-frozen, and every config `resolveIdentifiedConfig`/
  `resolveAnonymousConfig` returns is frozen too.
- CommonJS `require("trust-core")` works alongside `import`, on Node
  20.19+/22.12+ (`require(esm)` support) — `exports` adds a `default`
  condition next to `import` for every entry point.
- `identified.scoreEntity`'s and `anonymous.assessAuthenticity`'s clock
  option is named `now` on both (previously `asOf` on `identified`), and
  accepts a `Date` as well as a strict ISO 8601 string. Calling either
  function without its required options argument now throws the kit's own
  `TypeError` instead of a raw native one.
- Shipped `.js.map` files inline their source content (`inlineSources`) so
  go-to-definition resolves without `src/` in the tarball; `.d.ts.map` is not
  emitted (`declarationMap: false`), since `src/` itself isn't shipped.
