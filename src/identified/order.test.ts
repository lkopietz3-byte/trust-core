import { describe, expect, it } from "vitest";
import { compareContributions } from "./order.js";
import type { SignalContribution } from "./index.js";

const base: SignalContribution = { id: "b", tier: "t", source: "s", proof: "p", weight: 1, ageDays: 10 };
const cmp = (a: Partial<SignalContribution>, b: Partial<SignalContribution>): number =>
  compareContributions({ ...base, ...a }, { ...base, ...b });

describe("compareContributions returns a consistent sign for every key", () => {
  it("heavier weight sorts first, whatever the other keys", () => {
    expect(cmp({ weight: 2 }, { weight: 1, id: "a" })).toBeLessThan(0);
    expect(cmp({ weight: 1, id: "a" }, { weight: 2 })).toBeGreaterThan(0);
  });

  it.each([
    ["id", { id: "a" }, { id: "b" }],
    ["tier", { tier: "a" }, { tier: "b" }],
    ["source", { source: "a" }, { source: "b" }],
    ["proof", { proof: "a" }, { proof: "b" }],
    ["age", { ageDays: 1 }, { ageDays: 2 }],
    ["age vs unknown", { ageDays: 5000 }, { ageDays: null }],
  ] as const)("%s: the smaller value sorts first, and the sign flips when the arguments swap", (_key, lower, higher) => {
    expect(cmp(lower, higher)).toBe(-1);
    expect(cmp(higher, lower)).toBe(1);
  });

  it("an earlier key wins over a later one", () => {
    expect(cmp({ id: "a", tier: "z", ageDays: 99 }, { id: "b", tier: "a", ageDays: 1 })).toBe(-1);
    expect(cmp({ tier: "a", source: "z" }, { tier: "b", source: "a" })).toBe(-1);
    expect(cmp({ source: "a", proof: "z" }, { source: "b", proof: "a" })).toBe(-1);
    expect(cmp({ proof: "a", ageDays: 99 }, { proof: "b", ageDays: 1 })).toBe(-1);
  });

  it("identical contributions compare equal, including two unknown ages", () => {
    expect(cmp({}, {})).toBe(0);
    expect(cmp({ ageDays: null }, { ageDays: null })).toBe(0);
  });

  it("compares text by UTF-16 code unit, not by locale", () => {
    expect(cmp({ id: "B" }, { id: "a" })).toBe(-1);
    expect(cmp({ id: "a" }, { id: "B" })).toBe(1);
  });

  it("a very large weight difference keeps its sign", () => {
    expect(cmp({ weight: Number.MAX_VALUE }, { weight: -Number.MAX_VALUE })).toBeLessThan(0);
  });
});
