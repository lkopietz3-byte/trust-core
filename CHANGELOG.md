# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
`0.1.0` was published to npm on 2026-09-28. While the version is 0.x, a change that
makes a previously accepted input throw or return a different result bumps the minor version.

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
