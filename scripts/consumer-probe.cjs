// CommonJS require() smoke test: proves `require('trust-core')` works for a
// plain CommonJS consumer, the way package.json `exports`' `default`
// condition promises. scripts/verify-package.mjs only runs this file on a
// Node version that supports `require(esm)` (Node 22.12+ or 20.19+); on an
// older Node it logs a skip instead, since `require()` of an ESM-only
// package throws there regardless of `exports`. See README's CommonJS note.
'use strict';

const assert = require('node:assert/strict');

const root = require('trust-core');
const identified = require('trust-core/identified');
const anonymous = require('trust-core/anonymous');
const shared = require('trust-core/shared');

assert.equal(typeof root.identified.scoreEntity, 'function', 'root namespace export should be a function');
assert.equal(root.identified.scoreEntity, identified.scoreEntity, 'require()d root and subpath should share the same module');
assert.equal(root.anonymous.assessAuthenticity, anonymous.assessAuthenticity, 'require()d root and subpath should share the same module');
assert.equal(root.clamp, shared.clamp, 'root should re-export shared/types.js directly');
assert.equal(shared.clamp(15, 0, 10), 10, 'clamp should bound to the max');

const config = identified.resolveIdentifiedConfig({ tierWeights: { verified: 1.0 } });
const result = identified.scoreEntity(
  [
    {
      id: 'r1',
      tier: 'verified',
      source: 'direct',
      proof: 'none',
      reputation: 80,
      occurredAt: '2026-06-01T00:00:00Z',
      value: 90,
    },
  ],
  config,
  { now: '2026-08-01T00:00:00Z', prior: 50 },
);
assert.ok(result.score >= 0 && result.score <= 100, `score ${result.score} should be in [0, 100]`);

assert.throws(
  () => identified.scoreEntity([], config),
  TypeError,
  'scoreEntity called via require() should still validate a missing options argument',
);

console.log('consumer-probe.cjs: require() works');
