import { describe, expect, it } from "vitest";
import {
  composeDimensions,
  EXAMPLE_IDENTIFIED_CONFIG,
  resolveIdentifiedConfig,
  scoreEntity,
  signalWeight,
  type IdentifiedConfig,
  type IdentifiedSignal,
} from "./index.js";
import { resolveDial } from "../shared/types.js";

const NOW = "2026-08-01T00:00:00Z";

/** A deep, unfrozen, unvalidated copy: what a hand-built config looks like. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sig(overrides: Partial<IdentifiedSignal> = {}): IdentifiedSignal {
  return {
    id: "s",
    tier: "standard",
    source: "direct",
    proof: "none",
    reputation: null,
    occurredAt: NOW,
    value: 80,
    ...overrides,
  };
}

/** Values that are not a plain record: every one must be rejected, never treated as "no overrides". */
const NOT_A_PLAIN_RECORD: [string, unknown][] = [
  ["null", null],
  ["false", false],
  ["true", true],
  ["0", 0],
  ["42", 42],
  ["empty string", ""],
  ["a string", "recency"],
  ["NaN", Number.NaN],
  ["an array", []],
  ["a Date", new Date(0)],
  ["a Map", new Map()],
  ["a Set", new Set()],
  ["a RegExp", /x/],
  ["a class instance", new (class Custom {
    halfLifeDays = 1;
  })()],
  ["a function", () => 1],
];

describe("resolveIdentifiedConfig: only undefined means 'use the defaults' (TC-002)", () => {
  it("returns the example configuration for undefined and for an empty object", () => {
    expect(resolveIdentifiedConfig()).toBe(EXAMPLE_IDENTIFIED_CONFIG);
    expect(resolveIdentifiedConfig(undefined)).toBe(EXAMPLE_IDENTIFIED_CONFIG);
    expect(resolveIdentifiedConfig({})).toEqual(EXAMPLE_IDENTIFIED_CONFIG);
  });

  it.each(NOT_A_PLAIN_RECORD)("rejects %s as the top-level overrides with a TypeError", (_name, value) => {
    expect(() => resolveIdentifiedConfig(value as never)).toThrow(TypeError);
  });

  it.each(["tierWeights", "sourceWeights", "proofWeights", "reputation", "recency", "confidence"])(
    "rejects every non-record value for %s instead of spreading it into the defaults",
    (section) => {
      for (const [name, value] of NOT_A_PLAIN_RECORD) {
        expect(() => resolveIdentifiedConfig({ [section]: value }), `${section} = ${name}`).toThrow(TypeError);
      }
    },
  );

  it("treats an explicitly undefined section as absent, but null as invalid", () => {
    expect(resolveIdentifiedConfig({ recency: undefined })).toEqual(EXAMPLE_IDENTIFIED_CONFIG);
    expect(() => resolveIdentifiedConfig({ recency: null } as never)).toThrow(TypeError);
  });

  it("still merges a valid partial override over the defaults", () => {
    const resolved = resolveIdentifiedConfig({
      tierWeights: { trusted: 2 },
      recency: { halfLifeDays: 30 } as never,
    });
    expect(resolved.tierWeights).toEqual({ ...EXAMPLE_IDENTIFIED_CONFIG.tierWeights, trusted: 2 });
    expect(resolved.recency).toEqual({ halfLifeDays: 30, missingDateAgeDays: 720 });
    expect(Object.isFrozen(resolved.tierWeights)).toBe(true);
  });

  it("accepts null-prototype records", () => {
    const tierWeights = Object.assign(Object.create(null) as Record<string, number>, { trusted: 2 });
    expect(resolveIdentifiedConfig({ tierWeights }).tierWeights["trusted"]).toBe(2);
  });

  it("keeps a weight map key named __proto__ as data, not as a prototype", () => {
    const tierWeights = JSON.parse('{"__proto__": 3}') as Record<string, number>;
    const resolved = resolveIdentifiedConfig({ tierWeights });
    expect(Object.getPrototypeOf(resolved.tierWeights)).toBe(Object.prototype);
    expect(Object.hasOwn(resolved.tierWeights, "__proto__")).toBe(true);
  });

  it("rejects a nested key that is explicitly undefined, because a required number is missing", () => {
    expect(() => resolveIdentifiedConfig({ recency: { halfLifeDays: undefined } as never })).toThrow(TypeError);
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
      tierWeights: counted("tierWeights", { a: 1 }),
      sourceWeights: counted("sourceWeights", { a: 1 }),
      proofWeights: counted("proofWeights", { a: 1 }),
      reputation: counted("reputation", { floor: 1, ceil: 1, neutral: 1 }),
      recency: counted("recency", { halfLifeDays: 1, missingDateAgeDays: 1 }),
      confidence: counted("confidence", { high: 2, moderate: 1 }),
    });
    resolveIdentifiedConfig(overrides);
    expect(reads).toEqual({
      tierWeights: 1,
      sourceWeights: 1,
      proofWeights: 1,
      reputation: 1,
      recency: 1,
      confidence: 1,
    });
  });
});

describe("scoreEntity validates the config it is handed (class 1/6: one validated snapshot)", () => {
  const options = { now: NOW, prior: 50 };

  it("accepts a valid unfrozen copy of a config and scores it exactly like the frozen one", () => {
    const copy = clone(EXAMPLE_IDENTIFIED_CONFIG);
    expect(scoreEntity([sig()], copy, options)).toEqual(scoreEntity([sig()], EXAMPLE_IDENTIFIED_CONFIG, options));
  });

  it("rejects a config that is not a plain record", () => {
    for (const [, value] of NOT_A_PLAIN_RECORD) {
      expect(() => scoreEntity([sig()], value as never, options)).toThrow(TypeError);
    }
  });

  it("rejects a config with a missing section, a NaN weight, a typo key, or a non-record weight map", () => {
    const withoutTiers: Partial<IdentifiedConfig> = clone(EXAMPLE_IDENTIFIED_CONFIG);
    delete withoutTiers.tierWeights;
    expect(() => scoreEntity([sig()], withoutTiers as IdentifiedConfig, options)).toThrow(TypeError);
    const nan: IdentifiedConfig = clone(EXAMPLE_IDENTIFIED_CONFIG);
    nan.tierWeights["standard"] = Number.NaN;
    expect(() => scoreEntity([sig()], nan, options)).toThrow(RangeError);
    const typo = { ...clone(EXAMPLE_IDENTIFIED_CONFIG), recencyy: {} };
    expect(() => scoreEntity([sig()], typo as never, options)).toThrow(TypeError);
    const map = { ...clone(EXAMPLE_IDENTIFIED_CONFIG), tierWeights: new Map([["standard", 1]]) };
    expect(() => scoreEntity([sig()], map as never, options)).toThrow(TypeError);
  });

  it("signalWeight validates its config the same way", () => {
    expect(() => signalWeight(sig(), null as never, NOW)).toThrow(TypeError);
  });

  it("reads each config section once even when the config has getters", () => {
    let reads = 0;
    const base = clone(EXAMPLE_IDENTIFIED_CONFIG);
    const config = { ...base };
    Object.defineProperty(config, "tierWeights", {
      enumerable: true,
      get: () => {
        reads += 1;
        return base.tierWeights;
      },
    });
    scoreEntity([sig(), sig({ id: "b" }), sig({ id: "c" })], config, options);
    expect(reads).toBe(1);
  });
});

describe("scoreEntity reads each caller-supplied field once (class 1)", () => {
  it("uses one snapshot of every signal field and of the options", () => {
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
      id: counted("id", "x"),
      tier: counted("tier", "verified"),
      source: counted("source", "direct"),
      proof: counted("proof", "verified"),
      reputation: counted("reputation", 50),
      occurredAt: counted("occurredAt", "2026-01-01"),
      value: counted("value", 70),
    });
    const opts = {};
    Object.defineProperties(opts, {
      now: counted("now", NOW),
      prior: counted("prior", 50),
      dial: counted("dial", "balanced"),
    });
    scoreEntity([signal as IdentifiedSignal], EXAMPLE_IDENTIFIED_CONFIG, opts as never);
    expect(reads).toEqual({
      id: 1,
      tier: 1,
      source: 1,
      proof: 1,
      reputation: 1,
      occurredAt: 1,
      value: 1,
      now: 1,
      prior: 1,
      dial: 1,
    });
  });

  it("returns exactly the values it validated, even if a getter would answer differently on a second read", () => {
    let valueReads = 0;
    const signal = sig();
    Object.defineProperty(signal, "value", {
      enumerable: true,
      get: () => {
        valueReads += 1;
        return valueReads === 1 ? 50 : 99;
      },
    });
    const first = scoreEntity([signal], EXAMPLE_IDENTIFIED_CONFIG, { now: NOW, prior: 50, dial: 0 });
    expect(first.raw).toBe(50);
  });

  it("does not depend on array length being read again after the loop", () => {
    const signals = [sig({ id: "a" }), sig({ id: "b" })];
    let lengthReads = 0;
    const proxy = new Proxy(signals, {
      get(target, prop, receiver) {
        if (prop === "length") lengthReads += 1;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const result = scoreEntity(proxy, EXAMPLE_IDENTIFIED_CONFIG, { now: NOW, prior: 50 });
    expect(result.signalCount).toBe(2);
    expect(lengthReads).toBe(1);
  });
});

describe("sparse arrays and non-object elements are rejected, not skipped or half-read (class 2)", () => {
  const options = { now: NOW, prior: 50 };

  it("rejects a hole with a TypeError that names the index", () => {
    // eslint-disable-next-line no-sparse-arrays -- the hole is the test
    const sparse = [sig({ id: "a" }), , sig({ id: "c" })] as IdentifiedSignal[];
    expect(() => scoreEntity(sparse, EXAMPLE_IDENTIFIED_CONFIG, options)).toThrow(/signals\[1\]/);
    expect(() => scoreEntity(sparse, EXAMPLE_IDENTIFIED_CONFIG, options)).toThrow(TypeError);
    expect(() => scoreEntity(new Array<IdentifiedSignal>(2), EXAMPLE_IDENTIFIED_CONFIG, options)).toThrow(TypeError);
  });

  it("rejects null, primitives and arrays as signals with a TypeError", () => {
    for (const bad of [null, undefined, 5, "s", []]) {
      expect(() => scoreEntity([bad as never], EXAMPLE_IDENTIFIED_CONFIG, options)).toThrow(TypeError);
    }
  });

  it("requires signal ids to be strings, so an id can never 'match' by being undefined", () => {
    expect(() => scoreEntity([sig({ id: undefined as never })], EXAMPLE_IDENTIFIED_CONFIG, options)).toThrow(TypeError);
    expect(() => scoreEntity([sig({ id: 7 as never })], EXAMPLE_IDENTIFIED_CONFIG, options)).toThrow(TypeError);
  });

  it("composeDimensions rejects records that are not plain (a Map would read as empty)", () => {
    const s = scoreEntity([sig()], EXAMPLE_IDENTIFIED_CONFIG, options);
    expect(() => composeDimensions(new Map([["a", s]]) as never, { a: 1 })).toThrow(TypeError);
    expect(() => composeDimensions({ a: s }, new Map([["a", 1]]) as never)).toThrow(TypeError);
    expect(() => composeDimensions({ a: s }, [] as never)).toThrow(TypeError);
  });
});

describe("dial and lookups reject non-strings instead of coercing them (class 10)", () => {
  it.each([
    ["an array holding a preset name", ["balanced"]],
    ["a String object", new String("strict")],
    ["an object with toString", { toString: () => "strict" }],
    ["null", null],
    ["true", true],
    ["a symbol", Symbol("balanced")],
  ])("resolveDial rejects %s with a TypeError", (_name, dial) => {
    expect(() => resolveDial(dial as never)).toThrow(TypeError);
  });

  it("scoreEntity rejects a null dial rather than treating it as omitted, and still defaults undefined", () => {
    const base = { now: NOW, prior: 50 };
    expect(() => scoreEntity([sig()], EXAMPLE_IDENTIFIED_CONFIG, { ...base, dial: null as never })).toThrow(TypeError);
    expect(scoreEntity([sig()], EXAMPLE_IDENTIFIED_CONFIG, { ...base, dial: undefined })).toEqual(
      scoreEntity([sig()], EXAMPLE_IDENTIFIED_CONFIG, base),
    );
  });

  it("signalWeight rejects non-string tier/source/proof before any lookup", () => {
    const config = { ...EXAMPLE_IDENTIFIED_CONFIG };
    for (const field of ["tier", "source", "proof"] as const) {
      expect(() => signalWeight(sig({ [field]: ["verified"] as never }), config, NOW)).toThrow(TypeError);
      expect(() => signalWeight(sig({ [field]: new String("verified") as never }), config, NOW)).toThrow(TypeError);
    }
  });

  it("an unknown tier, source or proof is a RangeError, as documented (it used to be a bare Error)", () => {
    for (const field of ["tier", "source", "proof"] as const) {
      const bad = sig({ [field]: "no-such-key" });
      expect(() => signalWeight(bad, EXAMPLE_IDENTIFIED_CONFIG, NOW)).toThrow(RangeError);
    }
  });
});

describe("error messages neutralize control and bidi characters from caller strings (class 8)", () => {
  const hostile = "x\u001b[31m\nFORGED: ok\u202eevil\u2066";
  const messageOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("expected a throw");
  };
  const hasRaw = (text: string): boolean => /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(text);

  it("an unknown tier key is escaped in the message", () => {
    const message = messageOf(() => signalWeight(sig({ tier: hostile }), EXAMPLE_IDENTIFIED_CONFIG, NOW));
    expect(hasRaw(message)).toBe(false);
    expect(message).toContain("\\u001b");
    expect(message).toContain("\\u202e");
  });

  it("an unknown config key and a bad weight-map key are escaped", () => {
    expect(hasRaw(messageOf(() => resolveIdentifiedConfig({ [hostile]: 1 } as never)))).toBe(false);
    expect(hasRaw(messageOf(() => resolveIdentifiedConfig({ tierWeights: { [hostile]: -1 } })))).toBe(false);
    expect(hasRaw(messageOf(() => resolveIdentifiedConfig({ recency: { [hostile]: 1 } as never })))).toBe(false);
  });

  it("composeDimensions escapes dimension names", () => {
    const s = scoreEntity([sig()], EXAMPLE_IDENTIFIED_CONFIG, { now: NOW, prior: 50 });
    expect(hasRaw(messageOf(() => composeDimensions({ [hostile]: s }, { [hostile]: Number.NaN })))).toBe(false);
    expect(hasRaw(messageOf(() => composeDimensions({ [hostile]: null as never }, { [hostile]: 1 })))).toBe(false);
  });

  it("a long string value is truncated and escaped in a type error", () => {
    const message = messageOf(() => scoreEntity([sig()], EXAMPLE_IDENTIFIED_CONFIG, { now: `${hostile}${"y".repeat(100)}`, prior: 50 }));
    expect(hasRaw(message)).toBe(false);
    expect(message).toContain("...");
  });

  it("never throws while describing hostile values (bigint, symbol, throwing toString, cycles)", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const throwing = {
      toString() {
        throw new Error("boom");
      },
      toJSON() {
        throw new Error("boom");
      },
    };
    for (const value of [10n, Symbol("s"), throwing, cyclic, () => 1]) {
      expect(() => scoreEntity([sig()], EXAMPLE_IDENTIFIED_CONFIG, { now: value as never, prior: 50 })).toThrow(
        TypeError,
      );
    }
  });
});
