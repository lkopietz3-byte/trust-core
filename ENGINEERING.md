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
change), and runs `scripts/consumer-probe.mjs`/`.cjs`/`.mts` — probes that
import (or `require()`) the package by name and assert real outputs, not
just "it exports something." Regenerate `api-surface.json` with
`node scripts/verify-package.mjs --update-api` and review the diff.

## Packaging

This is an ESM package; `exports`' `default` condition also lets plain
CommonJS `require("trust-core")` work, on Node 20.19+/22.12+ (`require(esm)`
support — see README). `.js.map` files ship with `inlineSources` so
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

`attw`'s strict Node 10 resolution check currently fails for this package's `./identified`, `./anonymous`, and `./shared` subpath exports because there is no `typesVersions` fallback for a CommonJS-style (`moduleResolution: node`) resolver. CI runs with `--profile node16` to stay green while that's true. Fixing it needs a `typesVersions` entry in `package.json`, which ships in the npm tarball — out of scope for this repo-hygiene pass; it is planned for the per-kit follow-up pass.

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

Breaking API changes require a major version bump and a CHANGELOG entry explaining what
changed and why.

### Runtime support policy

- **Supported (recommended for production):** Node 22 and 24 LTS; Node 26 current.
- **Compatibility-tested:** Node 20. Node 20 is end-of-life — nodejs.org's release page
  (<https://nodejs.org/en/about/previous-releases>) lists it as `EOL`, with its final release
  dated Mar 24, 2026. The `compat` job in `verify.yml` still runs on Node 20 to catch
  regressions, but that runtime gets no security fixes upstream; don't run production traffic
  on it.
- CommonJS `require()` of this package needs Node >=20.19 or >=22.12 (`require(esm)`
  support). ESM `import` works on every version this package tests (20, 22, 24).
- `engines` in `package.json` is unchanged by this policy.

### Publishing with provenance

`.github/workflows/release.yml` publishes using npm trusted publishing: it triggers on
`workflow_dispatch` or a pushed `v*` tag, requests a short-lived OIDC token instead of
reading a stored npm token (`permissions: id-token: write`), and runs a plain `npm publish`
with no token and no `--provenance` flag, because provenance attestation is generated
automatically under trusted publishing. Before publishing, the workflow confirms the tag
matches `package.json`'s `version` and checks whether that version is already on the
registry, so re-running it on a version that's already published is a no-op rather than an
error. Trusted publishing must be configured for this package on npmjs.com (linking it to this
GitHub repository and the `release.yml` workflow) before the first automated release will
work.
