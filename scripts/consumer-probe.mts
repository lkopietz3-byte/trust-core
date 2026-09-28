// Strict NodeNext type probe: uses the public types the way a TypeScript
// consumer would, imported by package name from the installed tarball. Type
// errors here mean a declaration is missing, wrong, or not exported the way
// package.json's `exports`/`types` claims. Runtime checks use plain `throw`
// (not `node:assert`) so this doesn't need @types/node as a dev dependency —
// see the shared standard's baseline-defects note.
import {
  identified,
  anonymous,
  clamp,
  type Confidence,
  type TrustDialPreset,
} from "trust-core";
import {
  scoreEntity,
  resolveIdentifiedConfig,
  type IdentifiedConfig,
  type IdentifiedSignal,
  type EntityScore,
} from "trust-core/identified";
import {
  assessAuthenticity,
  resolveAnonymousConfig,
  type AnonymousConfig,
  type AnonymousSignal,
  type AuthenticityAssessment,
} from "trust-core/anonymous";
import { shrinkTowardPrior, resolveDial, type Weight } from "trust-core/shared";

const dialPreset: TrustDialPreset = "balanced";
const boundedValue: number = clamp(150, 0, 100);
if (boundedValue !== 100) throw new Error("clamp did not bound to the max");

const idConfig: IdentifiedConfig = resolveIdentifiedConfig({
  tierWeights: { verified: 1.0 },
});
const idSignal: IdentifiedSignal = {
  id: "r1",
  tier: "verified",
  source: "direct",
  proof: "none",
  reputation: 80,
  occurredAt: "2026-06-01T00:00:00Z",
  value: 90,
};
const idResult: EntityScore = scoreEntity([idSignal], idConfig, {
  now: "2026-08-01T00:00:00Z",
  prior: 50,
  dial: dialPreset,
});
const weight: Weight = idResult.contributions[0]?.weight ?? 0;
if (typeof weight !== "number") throw new Error("SignalContribution.weight should be a number");

const anonConfig: AnonymousConfig = resolveAnonymousConfig({
  sourceWeights: { forum: 0.85 },
});
const anonSignal: AnonymousSignal = {
  id: "s1",
  source: "forum",
  sentiment: 0.6,
  confidence: 0.9,
  publishedAt: "2026-07-01T00:00:00Z",
};
const anonResult: AuthenticityAssessment = assessAuthenticity([anonSignal], anonConfig, {
  now: "2026-08-01T00:00:00Z",
});
if (anonResult.flags.uniformSentiment !== false) throw new Error("expected a single signal to not flag uniformSentiment");

// Namespace re-exports from the root entry point line up with the direct
// subpath exports, at the type level.
const viaNamespace: EntityScore = identified.scoreEntity([idSignal], idConfig, {
  now: "2026-08-01T00:00:00Z",
  prior: 50,
});
const viaNamespaceAnon: AuthenticityAssessment = anonymous.assessAuthenticity([anonSignal], anonConfig, {
  now: "2026-08-01T00:00:00Z",
});
// trustScore is `number | null`: a consumer must handle "no score" before comparing.
const anonScore: number | null = viaNamespaceAnon.trustScore;
if (viaNamespace.score < 0 || (anonScore !== null && anonScore < 0)) throw new Error("scores should be non-negative");

// The insufficient-evidence outcome is part of the public types.
const level: Confidence["level"] = anonResult.confidence.level;
const reason: string | undefined = anonResult.confidence.reason;
const eligible: number = anonResult.eligibleSignalCount;
const insufficient: Confidence = { level: "insufficient", effectiveSampleSize: 0, reason: "no evidence" };
if (typeof level !== "string" || typeof eligible !== "number" || insufficient.reason === undefined) {
  throw new Error("Confidence and eligibleSignalCount should be typed");
}
void reason;

const dialStrength: number = resolveDial("strict");
const shrunk: number = shrinkTowardPrior(90, 1, 50, dialStrength);
if (!Number.isFinite(shrunk)) throw new Error("shrinkTowardPrior should return a finite number");

console.log("consumer-probe.mts: type-checked and ran without throwing");
