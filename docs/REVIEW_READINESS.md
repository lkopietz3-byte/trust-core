# Review and launch readiness

Updated September 30, 2026 against GitHub main `7e25eb99c8f2f7432e019dab8620974139304f51`. This note prepares review of work after the 0.2.0 release; it is not a completed product audit or marketing certification.

Registry check on September 30, 2026 returned `trust-core@0.2.0`. The response did not provide gitHead, so the published tarball's source commit remains unverified here.

## Review cadence

Keep automatic code reviews off during preparation. Request one focused `@codex review` on a meaningful candidate PR after relevant checks; repeat only when material changes invalidate the previous review. Do not add a recurring review schedule.

When this repo enters sustained launch/customer-facing development, enable its repository setting individually with **All PRs / On PR open / Exhaustive Off**. Keep the personal automatic default and credit-funded reviews off. Inspect the first result before expanding cadence. Review guidance lives in the root [AGENTS.md](../AGENTS.md); automated review supplements existing tests and release requirements.

The six repo settings were verified off on September 29, 2026. These preferences are managed in ChatGPT, not activated by committing this file.

## Next preparation task: Bound the public trust claims

Reconcile README/package authenticity and trust copy with caller-supplied labels, statistical heuristics and each API's missing-evidence shape.

Finish condition: Every public promise maps to documented behavior; examples show insufficient evidence without claiming truth, identity or fraud verification.

## Declared verification commands

Read from the inspected main's `package.json`. The PR records execution results for its final head; report any required check that is unavailable rather than treating it as passed. Use focused checks during implementation and existing release gates on the frozen candidate.

- `npm run verify`: `npm run lint && npm run typecheck && npm test && npm run build && npm run verify:package`
- `npm run lint`: `eslint . --max-warnings=0`
- `npm run typecheck`: `tsc --noEmit`
- `npm run test`: `vitest run`
- `npm run build`: `node -e "require('fs').rmSync('dist',{recursive:true,force:true})" && tsc -p tsconfig.build.json`
- `npm run attw`: `attw --pack . --ignore-rules cjs-resolves-to-esm`

Local tests, hosted authorization, published package resolution, deployed behavior and demand are separate evidence. Dated receipts apply to their recorded revision.

## Source basis

- [ENGINEERING.md](../ENGINEERING.md)
- [PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md)
- [src/anonymous/index.ts](../src/anonymous/index.ts)

Public marketing claims must be supported by current candidate evidence. Private-data transfers, commercial commitments, database promotion and deployment retain their existing authorization boundaries.
