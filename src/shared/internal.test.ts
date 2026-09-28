import { describe, expect, it } from "vitest";
import { checkNumber, exactSum } from "./internal.js";

describe("exactSum finiteness (TC-001)", () => {
  it("rejects a lone non-finite term (a singleton sum used to return it unchecked)", () => {
    expect(() => exactSum([Number.POSITIVE_INFINITY])).toThrow(RangeError);
    expect(() => exactSum([Number.NaN])).toThrow(RangeError);
    expect(() => exactSum([1, Number.NEGATIVE_INFINITY])).toThrow(RangeError);
  });

  it("rejects an overflowing sum of finite terms", () => {
    expect(() => exactSum([Number.MAX_VALUE, Number.MAX_VALUE])).toThrow(RangeError);
  });

  it("still sums ordinary and large finite values exactly", () => {
    expect(exactSum([])).toBe(0);
    expect(exactSum([0.1, 0.2, 0.3])).toBe(0.6);
    expect(exactSum([1e300, 1, -1e300])).toBe(1);
    expect(exactSum([Number.MAX_VALUE])).toBe(Number.MAX_VALUE);
  });
});

describe("checkNumber", () => {
  it("names the bounds in a range error", () => {
    expect(() => checkNumber(5, "x", { min: 0, max: 1 })).toThrow(/between 0 and 1/);
    expect(() => checkNumber(-1, "x", { min: 0 })).toThrow(/>= 0/);
    expect(() => checkNumber(0, "x", { min: 0, minExclusive: true })).toThrow(/> 0/);
    expect(() => checkNumber(2, "x", { max: 1 })).toThrow(/<= 1/);
  });

  it("accepts Infinity only when allowed, and never NaN", () => {
    expect(checkNumber(Infinity, "x", { allowInfinity: true })).toBe(Infinity);
    expect(() => checkNumber(Infinity, "x")).toThrow(/finite/);
    expect(() => checkNumber(Number.NaN, "x", { allowInfinity: true })).toThrow(RangeError);
  });

  it("throws TypeError for a non-number", () => {
    expect(() => checkNumber("1", "x")).toThrow(TypeError);
  });
});
