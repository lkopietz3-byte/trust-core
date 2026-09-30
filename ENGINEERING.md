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
- **Finite results.** A value derived from valid inputs (a weight product, a
  sum, a shrinkage term) that overflows or is not finite is a `RangeError`,
  never `NaN`, `Infinity`, or an overflow the final clamp turns into `100`.
- **Only `undefined` means defaults.** `resolve*Config` accepts `undefined` or
  a plain object; every other value is a `TypeError`, and each section is
  validated before it is merged. Scoring functions validate the config they
  are given and read each caller field once.
- **Eligible evidence only.** A zero-weight signal (identified) or an
  observation whose effective weight (credibility x confidence x recency decay)
  is 0 (anonymous) contributes nothing to any output. With no eligible evidence,
  `confidence.level` is `"insufficient"` with a `reason`.
- **Stable order.** `contributions` ties are broken by id, tier, source, proof,
  then age, so input order never changes the result.
- **Immutability.** `EXAMPLE_IDENTIFIED_CONFIG`, `EXAMPLE_ANONYMOUS_CONFIG`,
  `TRUST_DIALS`, and every config `resolveIdentifiedConfig`/
  `resolveAnonymousConfig` returns are deep-frozen.
- **Zero runtime dependencies.** `dependencies` in package.json stays empty.

## Setup and verification

```bash
npm ci                # install pinned dev toolchain
npm run verify         # lint + typecheck + test + build + verify:package
npm run attw           # are-the-types-wrong on the packed tarball (node10, node16, bundler)
npm run audit:dependencies
```

Mutation testing is run locally, not in CI: `npm i -D --no-save
@stryker-mutator/core @stryker-mutator/vitest-runner`, then `npx stryker run`
with an uncommitted `stryker.config.json` (`testRunner: "vitest"`,
`mutate: ["src/**/*.ts", "!src/**/*.test.ts"]`). The 0.2.0 run scored 99.02%
(913 of 922 mutants killed or timed out; it was 57.2% before the fix pass). The 9
survivors are: `w <= 0` vs `w < 0` in `composeDimensions` (a zero weight adds zero, so
equivalent), the `<` vs `<=` swap on equal magnitudes in `exactSum` (the swap is
symmetric, so equivalent), and 7 in the final rounding step of `exactSum` (an early-exit
test and the sign tests of its round-half-even correction). A 20,000-case BigInt oracle
plus constructed near-ties could not separate those 7 from the original, so treat them as
unproven equivalents, not as proven ones.

## Packaging

This is an ESM package; `exports`' `default` condition also lets plain
CommonJS `require("trust-core")` work, on Node 20.19+/22.12+ (`require(esm)`
support — see README). `typesVersions` maps the `identified`, `anonymous` and `shared` subpaths for
legacy `moduleResolution: node` (node10). `.js.map` files ship with `inlineSources` so
go-to-definition resolves without `src/` in the tarball; `.d.ts.map` is
turned off (`declarationMap: false`) for the same reason, rather than shipping
`src/` just to back it.

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

## Are the types wrong? (attw)

CI runs [`arethetypeswrong`](https://github.com/arethetypeswrong/arethetypeswrong.github.io)
(`npm run attw`, which is `attw --pack . --ignore-rules cjs-resolves-to-esm --profile node16`)
against the packed tarball after the build step. The `cjs-resolves-to-esm` rule is ignored on
purpose: this is an ESM-only package (`"type": "module"`, no `require` entry point), so a
CommonJS consumer must use Node's `require(esm)` support (Node >=20.19 or >=22.12 — see
"Runtime support policy" below) rather than a native `require`. A dual CJS+ESM build was
rejected to avoid the dual-package hazard (two separately-identified copies of the same module,
with broken `instanceof` checks and duplicated module state across the CJS and ESM entry
points).

`attw` checks the node10, node16 (CJS and ESM) and bundler profiles for all four
entry points; `typesVersions` is what makes the node10 column resolve the subpaths.
`verify:package` also type-checks the consumer probe under node10 resolution.

## Release and rollback

`npm run verify` (lint, typecheck, test, build, verify:package) runs automatically before
publish via the `prepublishOnly` script, so a broken build cannot reach the registry by
accident. To release: add a dated entry to `CHANGELOG.md`, bump `version` in
`package.json`, commit, and push a `vX.Y.Z` tag that matches the new version, then let
`.github/workflows/release.yml` install, verify, and publish it. (You can also run
`npm publish` locally; `prepublishOnly` still guards it.)

npm's unpublish policy is deliberately narrow. Within 72 hours of publishing, a version can be
unpublished only if no other published package depends on it. After 72 hours, unpublishing also
requires fewer than 300 downloads in the last week and a single maintainer — most released
versions won't qualify either way. A given `name@version` can never be reused, published or
not, even after an unpublish. Treat unpublish as unavailable: prefer fixing forward with a new
patch version, and use `npm deprecate <name>@"<range>" "<message>"` to warn consumers off a
bad release while it stays installable for anyone already pinned to it.

Breaking API changes require a CHANGELOG entry explaining what changed and why. While the
version is 0.x, a change that makes a previously accepted input throw or return a different
result bumps the MINOR version (0.1.0 to 0.2.0); from 1.0 it requires a major bump.

### Runtime support policy

- **Supported (recommended for production):** Node 22 and 24 LTS; Node 26 current.
- **Compatibility-tested:** Node 20. Node 20 is end-of-life — nodejs.org's release page
  (<https://nodejs.org/en/about/previous-releases>) lists it as `EOL`, with its final release
  dated Mar 24, 2026. The `compat` job in `verify.yml` still runs on Node 20.19.0 to catch
  regressions, but that runtime gets no security fixes upstream; don't run production traffic
  on it.
- CommonJS `require()` of this package needs Node >=20.19 or >=22.12 (`require(esm)`
  support). ESM `import` works on every version this package tests (20.19.0, 22.12.0, 24).
  The `compat` job pins the two `require(esm)` floors exactly.
- `engines` in `package.json` is unchanged by this policy.

### Publishing with provenance

`.github/workflows/release.yml` publishes using npm trusted publishing: it triggers on
`workflow_dispatch` or a pushed `v*` tag, requests a short-lived OIDC token instead of
reading a stored npm token (`permissions: id-token: write`), and runs a plain `npm publish`
with no token and no `--provenance` flag, because provenance attestation is generated
automatically under trusted publishing. Both triggers must run on a `v*` tag that matches
`package.json`'s `version`; a manual run from a branch fails. Before publishing, the job runs
`npm run audit:dependencies`, `npm run verify` and `npm run attw`, then asks the registry about
`name@version`: only a confirmed `E404` means "not published yet". Any other registry error
(outage, auth, network) fails the job instead of guessing, and an already-published version is a
no-op. Trusted publishing must be configured for this package on npmjs.com (linking it to this
GitHub repository and the `release.yml` workflow) before the first automated release will
work.
