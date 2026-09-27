# Engineering contract

## Invariants

- **Range.** `identified.scoreEntity`'s `score`/`raw` and `anonymous.assessAuthenticity`'s
  `trustScore` always stay within their documented `[0, 100]` range — validated
  inputs plus a final `clamp` as a floating-point safety net.
- **Determinism.** Every exported function is pure: no `Date.now()`, no
  `Math.random()`, no I/O. The same inputs always produce the same output.
- **Order independence.** Every internal sum over a signal array uses
  compensated (Shewchuk/`fsum`-style) summation, so the result does not
  depend on what order the signals are listed in and does not drift as the
  count grows.
- **Fail loud, not silent.** A malformed input (out of range, wrong type,
  `NaN`, `Infinity`, an unknown config key, a prototype-chain lookup key such
  as `"constructor"`) throws a `TypeError`/`RangeError`. It never silently
  degrades into a plausible-looking but wrong score.
- **Immutability.** `EXAMPLE_IDENTIFIED_CONFIG`, `EXAMPLE_ANONYMOUS_CONFIG`,
  `TRUST_DIALS`, and every config `resolveIdentifiedConfig`/
  `resolveAnonymousConfig` returns are deep-frozen.
- **Zero runtime dependencies.** `dependencies` in package.json stays empty.

## Setup and verification

```bash
npm ci                # install pinned dev toolchain
npm run verify         # lint + typecheck + test + build + verify:package
npm audit --include=dev
```

`npm run verify:package` packs the built tarball, installs it into a clean
temp project, imports every `exports` entry by its public specifier, checks
the result against `api-surface.json` (a deliberate diff on any public API
change), and runs `scripts/consumer-probe.mjs`/`.mts` — a probe that imports
the package by name and asserts real outputs, not just "it exports
something." Regenerate `api-surface.json` with
`node scripts/verify-package.mjs --update-api` and review the diff.

## What is NOT certified

- Neither module verifies that any underlying claim, review, or event is
  true. `identified` weights the credibility of supplied signals; `anonymous`
  scores how organic a sentiment pattern looks. Neither is a truth or fraud
  detector — see README's "Honest limits".
- The astroturf heuristics catch two specific statistical shapes
  (source concentration, near-uniform sentiment). A campaign that varies its
  wording and sentiment is not guaranteed to be caught.
- Config validation catches malformed configuration; it cannot catch
  well-formed configuration that is simply wrong for your domain (a bad
  `prior`, miscalibrated weights).
- Cross-entity/cross-contributor correlation (e.g. sockpuppet rings) is out of scope — both modules score one entity's corpus at a time.

## Release and rollback

`npm run verify` (lint, typecheck, test, build, verify:package) runs
automatically before publish via the `prepublishOnly` script. This is a
pure-function library with no persisted state and no migrations, so npm
allows `npm unpublish` only within 72 hours of publishing; after that,
publish a fixed patch version instead of trying to unpublish a bad release.
Breaking API changes require a major version bump and a CHANGELOG entry
explaining what changed and why.
