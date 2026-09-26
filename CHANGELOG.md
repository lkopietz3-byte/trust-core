# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project has not been published to npm yet, so the version stays `0.1.0`
until the first real release.

## [0.1.0] - Unreleased

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
