# trust-core — agent instructions

Deterministic entity-trust scoring: weight known contributors' signals, and gauge how organic anonymous sentiment looks. Zero runtime dependencies.

## Read first
- `ENGINEERING.md` holds this package's invariants and design rules; read it before changing behavior.
- `PROJECT_CONTEXT.md` is the current project state and decisions.
- `SECURITY.md` covers the security posture; follow it for anything touching input handling.

## Commands (from package.json)
- `npm run verify`
- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run verify:package` packs and installs the tarball offline; run `npm run build` first.

## Rules
- Run `npm run verify` and read its output before calling work done. Report any step that did not run.
- Build cleans `dist/` first; never trust a stale `dist/` for declaration or package checks.
- Never weaken lint, tests or `api-surface.json` to get green. Public API changes are deliberate (`node scripts/verify-package.mjs --update-api`) and must be called out.
- Do not run `npm publish` or push tags without explicit permission. Treat any claim that a version is published as Reported until the registry confirms it.
- Runtime `dependencies` stay empty; add dev tooling only.
- Keep unrelated uncommitted work intact; never stage or reset the whole tree.

## Review preparation

Use [docs/REVIEW_READINESS.md](docs/REVIEW_READINESS.md) for milestone review cadence and launch-preparation evidence.


## Code Review Rules

- Preserve deterministic scoring with explicit time, stable order/summation and finite bounded outputs. Only `undefined` may select documented configuration defaults; malformed input must throw rather than produce a plausible score.
- Keep claims bounded to the actual heuristic and caller-supplied credibility/source labels. Statistical patterns do not verify truth, identity, independence or fraud; domain calibration remains the caller's responsibility.
- Treat absent eligible evidence as insufficient or missing evidence using each API's documented output shape. Do not turn it into a measured low-trust score or count zero-weight submissions as supporting evidence.
