import { describe, expect, it } from "vitest";
import {
  assessAuthenticity,
  EXAMPLE_ANONYMOUS_CONFIG,
  resolveAnonymousConfig,
  type AnonymousConfig,
  type AnonymousSignal,
} from "./index.js";

const NOW = "2026-08-01T00:00:00Z";

/** A deep, unfrozen, unvalidated copy: what a hand-built config looks like. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sig(overrides: Partial<AnonymousSignal> = {}): AnonymousSignal {
  return { id: "s", source: "forum", sentiment: 0.5, confidence: 0.9, publishedAt: "2026-07-15T00:00:00Z", ...overrides };
}

const NOT_A_PLAIN_RECORD: [string, unknown][] = [
  ["null", null],
  ["false", false],
  ["0", 0],
  ["empty string", ""],
  ["a string", "x"],
  ["NaN", Number.NaN],
  ["an array", []],
  ["a Date", new Date(0)],
  ["a Map", new Map()],
  ["a class instance", new (class Custom {
    high = 1;
  })()],
];

describe("resolveAnonymousConfig: only undefined means 'use the defaults' (TC-002)", () => {
  it("returns the example configuration for undefined and for an empty object", () => {
    expect(resolveAnonymousConfig()).toBe(EXAMPLE_ANONYMOUS_CONFIG);
    expect(resolveAnonymousConfig({})).toEqual(EXAMPLE_ANONYMOUS_CONFIG);
  });

  it.each(NOT_A_PLAIN_RECORD)("rejects %s as the top-level overrides with a TypeError", (_name, value) => {
    expect(() => resolveAnonymousConfig(value as never)).toThrow(TypeError);
  });

  it.each(["sourceWeights", "weights", "recency", "astroturf", "confidence"])(
    "rejects every non-record value for %s instead of spreading it into the defaults",
    (section) => {
      for (const [name, value] of NOT_A_PLAIN_RECORD) {
        expect(() => resolveAnonymousConfig({ [section]: value }), `${section} = ${name}`).toThrow(TypeError);
      }
    },
  );

  it.each(["astroturfWeight", "volumeSaturation"])("rejects null and non-numbers for %s, but undefined means default", (key) => {
    expect(() => resolveAnonymousConfig({ [key]: null })).toThrow(TypeError);
    expect(() => resolveAnonymousConfig({ [key]: "0.3" })).toThrow(TypeError);
    expect(resolveAnonymousConfig({ [key]: undefined })).toEqual(EXAMPLE_ANONYMOUS_CONFIG);
  });

  it("still merges valid partial overrides, including null-prototype records", () => {
    const sourceWeights = Object.assign(Object.create(null) as Record<string, number>, { podcast: 0.7 });
    const resolved = resolveAnonymousConfig({ sourceWeights, astroturfWeight: 0.5 });
    expect(resolved.sourceWeights["podcast"]).toBe(0.7);
    expect(resolved.sourceWeights["forum"]).toBe(EXAMPLE_ANONYMOUS_CONFIG.sourceWeights["forum"]);
    expect(resolved.astroturfWeight).toBe(0.5);
    expect(Object.isFrozen(resolved.astroturf)).toBe(true);
  });

  it("reads every caller-supplied property exactly once", () => {
    const reads: Record<string, number> = {};
    const counted = (name: string, value: unknown): PropertyDescriptor => ({
      enumerable: true,
      get: () => {
        reads[name] = (reads[name] ?? 0) + 1;
        return value;
      },
    });
    const overrides = {};
    Object.defineProperties(overrides, {
      sourceWeights: counted("sourceWeights", { a: 1 }),
      weights: counted("weights", { consensus: 1, diversity: 1, volume: 1, recency: 1 }),
      astroturfWeight: counted("astroturfWeight", 0.1),
      recency: counted("recency", { halfLifeDays: 1, missingDateAgeDays: 1 }),
      volumeSaturation: counted("volumeSaturation", 3),
      astroturf: counted("astroturf", { ...EXAMPLE_ANONYMOUS_CONFIG.astroturf }),
      confidence: counted("confidence", { high: 2, moderate: 1 }),
    });
    resolveAnonymousConfig(overrides);
    expect(Object.values(reads)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });
});

describe("assessAuthenticity validates the config it is handed", () => {
  const options = { now: NOW };

  it("accepts a valid unfrozen copy and matches the frozen config's result", () => {
    const copy = clone(EXAMPLE_ANONYMOUS_CONFIG);
    expect(assessAuthenticity([sig()], copy, options)).toEqual(assessAuthenticity([sig()], EXAMPLE_ANONYMOUS_CONFIG, options));
  });

  it("rejects non-record configs, missing sections, NaN weights and typo keys", () => {
    for (const [, value] of NOT_A_PLAIN_RECORD) {
      expect(() => assessAuthenticity([sig()], value as never, options)).toThrow(TypeError);
    }
    const withoutRules: Partial<AnonymousConfig> = clone(EXAMPLE_ANONYMOUS_CONFIG);
    delete withoutRules.astroturf;
    expect(() => assessAuthenticity([sig()], withoutRules as AnonymousConfig, options)).toThrow(TypeError);
    const nan: AnonymousConfig = clone(EXAMPLE_ANONYMOUS_CONFIG);
    nan.sourceWeights["forum"] = Number.NaN;
    expect(() => assessAuthenticity([sig()], nan, options)).toThrow(RangeError);
    expect(() => assessAuthenticity([sig()], { ...clone(EXAMPLE_ANONYMOUS_CONFIG), typo: 1 } as never, options)).toThrow(TypeError);
  });
});

describe("assessAuthenticity reads each caller-supplied field once and rejects holes (classes 1 and 2)", () => {
  it("snapshots every signal field and the options once", () => {
    const reads: Record<string, number> = {};
    const counted = (name: string, value: unknown): PropertyDescriptor => ({
      enumerable: true,
      get: () => {
        reads[name] = (reads[name] ?? 0) + 1;
        return value;
      },
    });
    const signal = {};
    Object.defineProperties(signal, {
      source: counted("source", "forum"),
      sentiment: counted("sentiment", 0.4),
      confidence: counted("confidence", 0.8),
      publishedAt: counted("publishedAt", "2026-07-01"),
    });
    const opts = {};
    Object.defineProperty(opts, "now", counted("now", NOW));
    assessAuthenticity([signal as AnonymousSignal], EXAMPLE_ANONYMOUS_CONFIG, opts as never);
    expect(reads).toEqual({ source: 1, sentiment: 1, confidence: 1, publishedAt: 1, now: 1 });
  });

  it("rejects a hole with a TypeError that names the index", () => {
    // eslint-disable-next-line no-sparse-arrays -- the hole is the test
    const sparse = [sig(), , sig()] as AnonymousSignal[];
    expect(() => assessAuthenticity(sparse, EXAMPLE_ANONYMOUS_CONFIG, { now: NOW })).toThrow(/signals\[1\]/);
    expect(() => assessAuthenticity(new Array<AnonymousSignal>(3), EXAMPLE_ANONYMOUS_CONFIG, { now: NOW })).toThrow(TypeError);
  });

  it("rejects null, primitives and arrays as signals with a TypeError", () => {
    for (const bad of [null, undefined, 5, "s", []]) {
      expect(() => assessAuthenticity([bad as never], EXAMPLE_ANONYMOUS_CONFIG, { now: NOW })).toThrow(TypeError);
    }
  });

  it("a non-string source can never coerce into a lookup key", () => {
    for (const source of [["forum"], new String("forum"), 1, null, undefined]) {
      expect(() => assessAuthenticity([sig({ source: source as never })], EXAMPLE_ANONYMOUS_CONFIG, { now: NOW })).toThrow(TypeError);
    }
  });
});

describe("error messages neutralize control and bidi characters from caller strings (class 8)", () => {
  const hostile = "x\u001b[31m\nFORGED\u202eevil\u2066";
  const messageOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("expected a throw");
  };
  const hasRaw = (text: string): boolean => /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(text);

  it("escapes hostile keys and values in config and signal errors", () => {
    expect(hasRaw(messageOf(() => resolveAnonymousConfig({ [hostile]: 1 } as never)))).toBe(false);
    expect(hasRaw(messageOf(() => resolveAnonymousConfig({ sourceWeights: { [hostile]: -1 } })))).toBe(false);
    expect(hasRaw(messageOf(() => resolveAnonymousConfig({ astroturf: { [hostile]: 1 } as never })))).toBe(false);
    expect(hasRaw(messageOf(() => assessAuthenticity([sig({ publishedAt: hostile })], EXAMPLE_ANONYMOUS_CONFIG, { now: NOW })))).toBe(false);
    expect(hasRaw(messageOf(() => assessAuthenticity([], EXAMPLE_ANONYMOUS_CONFIG, { now: hostile })))).toBe(false);
  });
});
