import { describe, expect, it } from "vitest";
import {
  checkArray,
  checkClock,
  checkPlainRecord,
  checkRecord,
  checkRecencyCurve,
  checkString,
  checkThresholds,
  checkTimestamp,
  deepFreeze,
  isPlainObject,
  rejectUnknownKeys,
  show,
  snapshotArray,
  checkNumber,
  exactSum,
} from "./internal.js";

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

describe("isPlainObject / checkPlainRecord (class 6)", () => {
  it("accepts object literals and null-prototype objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject(JSON.parse("{}"))).toBe(true);
  });

  it("rejects arrays, built-ins, class instances, functions and primitives", () => {
    class Custom {}
    for (const value of [[], new Date(0), new Map(), new Set(), /x/, new Custom(), new Error("e"), () => 1, null, undefined, 1, "s", true, Symbol("s"), 1n]) {
      expect(isPlainObject(value)).toBe(false);
    }
  });

  it("checkPlainRecord returns the record itself and throws TypeError otherwise", () => {
    const record = { a: 1 };
    expect(checkPlainRecord(record, "x")).toBe(record);
    expect(() => checkPlainRecord(new Map(), "x")).toThrow(/x must be a plain object/);
    expect(() => checkPlainRecord(null, "x")).toThrow(TypeError);
  });

  it("checkRecord still accepts any non-null, non-array object (class instances with fields are fine as signals)", () => {
    class Custom {
      a = 1;
    }
    expect(checkRecord(new Custom(), "x")).toBeInstanceOf(Custom);
    expect(() => checkRecord([], "x")).toThrow(TypeError);
    expect(() => checkRecord(null, "x")).toThrow(TypeError);
  });

  it("checkArray and checkString throw TypeError for the wrong type", () => {
    expect(() => checkArray({}, "x")).toThrow(TypeError);
    expect(checkArray([1], "x")).toEqual([1]);
    expect(() => checkString(1, "x")).toThrow(TypeError);
    expect(checkString("", "x")).toBe("");
  });
});

describe("snapshotArray (class 2: one indexed traversal, holes rejected)", () => {
  it("returns a dense copy, not the caller's array", () => {
    const input = [1, 2, 3];
    const copy = snapshotArray(input, "xs");
    expect(copy).toEqual([1, 2, 3]);
    expect(copy).not.toBe(input);
  });

  it("returns an empty copy for an empty array", () => {
    expect(snapshotArray([], "xs")).toEqual([]);
  });

  it("keeps explicit undefined and null elements (they are validated later, not skipped)", () => {
    expect(snapshotArray([undefined, null], "xs")).toEqual([undefined, null]);
  });

  it("rejects a hole at any position with a TypeError naming the index", () => {
    // eslint-disable-next-line no-sparse-arrays -- the hole is the test
    expect(() => snapshotArray([, 1], "xs")).toThrow(/xs\[0\]/);
    // eslint-disable-next-line no-sparse-arrays -- the hole is the test
    expect(() => snapshotArray([1, , 3], "xs")).toThrow(/xs\[1\]/);
    expect(() => snapshotArray(new Array(1), "xs")).toThrow(TypeError);
  });

  it("rejects a non-array with a TypeError", () => {
    expect(() => snapshotArray({ length: 0 }, "xs")).toThrow(TypeError);
  });

  it("reads each element and the length once", () => {
    let indexReads = 0;
    let lengthReads = 0;
    const proxy = new Proxy([1, 2], {
      get(target, prop, receiver) {
        if (prop === "length") lengthReads += 1;
        else if (prop === "0" || prop === "1") indexReads += 1;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    snapshotArray(proxy, "xs");
    expect(lengthReads).toBe(1);
    expect(indexReads).toBe(2);
  });
});

describe("show() describes any value without throwing and neutralizes hostile text (classes 3 and 8)", () => {
  it("describes primitives and containers", () => {
    expect(show("abc")).toBe('"abc"');
    expect(show(5)).toBe("5");
    expect(show(Number.NaN)).toBe("NaN");
    expect(show(10n)).toBe("10");
    expect(show(undefined)).toBe("undefined");
    expect(show(true)).toBe("true");
    expect(show(null)).toBe("null");
    expect(show([])).toBe("an array");
    expect(show({})).toBe("an object");
    expect(show(() => 1)).toBe("a function");
    expect(show(Symbol("tag"))).toBe("Symbol(tag)");
  });

  it("truncates long strings at 48 characters and marks the cut", () => {
    expect(show("y".repeat(48))).toBe(`"${"y".repeat(48)}"`);
    expect(show("y".repeat(49))).toBe(`"${"y".repeat(48)}..."`);
  });

  it("escapes control characters, line and paragraph separators, and bidi/format characters", () => {
    expect(show("a\nb")).toBe('"a\\nb"');
    expect(show("\u001b")).toContain("\\u001b");
    expect(show("\u202e")).toBe('"\\u202e"');
    expect(show("\u2066\u2069\u061c\u200e")).toBe('"\\u2066\\u2069\\u061c\\u200e"');
    expect(show("\u2028\u2029")).toBe('"\\u2028\\u2029"');
    expect(show("\u00ad\u3164")).toBe('"\\u00ad\\u3164"');
    expect(show("\u{e0001}")).toBe('"\\u{e0001}"'); // astral format character (tag)
    expect(show("\u007f")).toBe('"\\u007f"');
    expect(show("\u0085")).toBe('"\\u0085"');
  });

  it("leaves ordinary text, including non-Latin scripts and emoji, readable", () => {
    expect(show("café 東京 \u{1F600}")).toBe('"café 東京 \u{1F600}"');
  });

  it("does not call a hostile toString or toJSON", () => {
    const hostile = {
      toString() {
        throw new Error("toString called");
      },
      toJSON() {
        throw new Error("toJSON called");
      },
    };
    expect(show(hostile)).toBe("an object");
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(show(cyclic)).toBe("an object");
  });
});

describe("checkTimestamp: calendar and offset ranges", () => {
  const parse = (value: string): number => checkTimestamp(value, "t");

  it("reads a date as midnight UTC and applies offsets", () => {
    expect(parse("2026-08-01")).toBe(Date.UTC(2026, 7, 1));
    expect(parse("2026-08-01T00:00:00Z")).toBe(Date.UTC(2026, 7, 1));
    expect(parse("2026-08-01T00:00:00+01:00")).toBe(Date.UTC(2026, 7, 1) - 3_600_000);
    expect(parse("2026-08-01T00:00:00-05:30")).toBe(Date.UTC(2026, 7, 1) + 19_800_000);
    expect(parse("2026-08-01T00:00Z")).toBe(Date.UTC(2026, 7, 1));
    expect(parse("2026-08-01T00:00:00.5Z")).toBe(Date.UTC(2026, 7, 1) + 500);
    expect(parse("2026-08-01T00:00:00.123456789Z")).toBe(Date.UTC(2026, 7, 1) + 123);
  });

  it("accepts the last valid value of every field", () => {
    expect(parse("2026-12-31T23:59:59Z")).toBe(Date.UTC(2026, 11, 31, 23, 59, 59));
    expect(parse("2026-08-01T00:00:00+23:59")).toBe(Date.UTC(2026, 7, 1) - (23 * 60 + 59) * 60_000);
    expect(parse("2028-02-29")).toBe(Date.UTC(2028, 1, 29));
  });

  it.each([
    ["impossible day", "2026-02-30"],
    ["impossible day (non-leap 29 Feb)", "2026-02-29"],
    ["day 0", "2026-01-00"],
    ["day 32", "2026-01-32"],
    ["month 0", "2026-00-10"],
    ["month 13", "2026-13-10"],
    ["hour 24", "2026-01-01T24:00:00Z"],
    ["minute 60", "2026-01-01T00:60:00Z"],
    ["second 60", "2026-01-01T00:00:60Z"],
    ["offset hour 24", "2026-01-01T00:00:00+24:00"],
    ["offset hour 25", "2026-01-01T00:00:00+25:00"],
    ["offset minute 60", "2026-01-01T00:00:00+01:60"],
    ["no offset", "2026-01-01T00:00:00"],
    ["local words", "June 1, 2026"],
    ["digits only", "1"],
    ["empty", ""],
    ["trailing junk", "2026-01-01Z"],
    ["leading space", " 2026-01-01"],
    ["ten fraction digits", "2026-01-01T00:00:00.1234567890Z"],
  ])("rejects %s with a RangeError", (_name, value) => {
    expect(() => parse(value)).toThrow(RangeError);
  });

  it("rejects non-strings with a TypeError and fails fast on very long junk", () => {
    expect(() => parse(5 as never)).toThrow(TypeError);
    const started = Date.now();
    expect(() => parse(`2026-01-01T00:00:00${"9".repeat(200_000)}`)).toThrow(RangeError);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("year 0050 is year 50, not 1950", () => {
    const date = new Date(0);
    date.setUTCFullYear(50, 0, 1);
    expect(parse("0050-01-01")).toBe(date.getTime());
  });

  it("checkClock accepts Dates and strings and rejects Invalid Dates and wrong types", () => {
    expect(checkClock(new Date(Date.UTC(2026, 7, 1)), "now")).toBe("2026-08-01T00:00:00.000Z");
    expect(checkClock("2026-08-01", "now")).toBe("2026-08-01");
    expect(() => checkClock(new Date("nonsense"), "now")).toThrow(RangeError);
    expect(() => checkClock(0, "now")).toThrow(TypeError);
  });
});

describe("config record helpers", () => {
  it("checkRecencyCurve validates both fields, allows an infinite half-life, and rejects typos", () => {
    expect(checkRecencyCurve({ halfLifeDays: Infinity, missingDateAgeDays: 0 }, "r")).toEqual({
      halfLifeDays: Infinity,
      missingDateAgeDays: 0,
    });
    expect(() => checkRecencyCurve({ halfLifeDays: -1, missingDateAgeDays: 0 }, "r")).toThrow(RangeError);
    expect(() => checkRecencyCurve({ halfLifeDays: 1, missingDateAgeDays: Infinity }, "r")).toThrow(RangeError);
    expect(() => checkRecencyCurve({ halfLifeDays: 1, missingDateAgeDays: 1, extra: 1 }, "r")).toThrow(TypeError);
    expect(() => checkRecencyCurve([], "r")).toThrow(TypeError);
  });

  it("checkThresholds orders moderate <= high, allows Infinity, and rejects typos and non-plain records", () => {
    expect(checkThresholds({ high: Infinity, moderate: 2 }, "t")).toEqual({ high: Infinity, moderate: 2 });
    expect(checkThresholds({ high: 2, moderate: 2 }, "t")).toEqual({ high: 2, moderate: 2 });
    expect(() => checkThresholds({ high: 1, moderate: 2 }, "t")).toThrow(/must not exceed/);
    expect(() => checkThresholds({ high: 1, moderate: 0, low: 0 }, "t")).toThrow(TypeError);
    expect(() => checkThresholds(new Map(), "t")).toThrow(TypeError);
    expect(() => checkThresholds({ high: -1, moderate: -2 }, "t")).toThrow(RangeError);
  });

  it("rejectUnknownKeys lists the allowed keys", () => {
    expect(() => rejectUnknownKeys({ a: 1, b: 2 }, ["a"], "cfg")).toThrow(/unknown key "b" \(allowed: a\)/);
    expect(() => rejectUnknownKeys({ a: 1 }, ["a", "b"], "cfg")).not.toThrow();
  });

  it("deepFreeze freezes nested objects and arrays and tolerates primitives and cycles", () => {
    const cyclic: Record<string, unknown> = { list: [{ inner: 1 }] };
    cyclic["self"] = cyclic;
    const frozen = deepFreeze(cyclic);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen["list"])).toBe(true);
    expect(Object.isFrozen((frozen["list"] as object[])[0])).toBe(true);
    expect(deepFreeze(5)).toBe(5);
    expect(deepFreeze(null)).toBe(null);
  });
});
