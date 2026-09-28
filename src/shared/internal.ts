/**
 * Internal helpers shared by the scoring modules. NOT public API: nothing in
 * `package.json` `exports` re-exports this file, so it is unreachable from an
 * installed package (and excluded from `api-surface.json`).
 *
 * Three jobs live here:
 *   - strict input validation, so a bad number becomes a clear error at the
 *     boundary instead of a `NaN` score three calls later;
 *   - a strict ISO 8601 timestamp parser, so results do not depend on the
 *     time zone of the process (`Date.parse` treats zone-less times as local);
 *   - exact (correctly rounded) summation, so a score does not change in its
 *     last bits when the same signals arrive in a different order.
 */

// ---------------------------------------------------------------------------
// Describing values in error messages
// ---------------------------------------------------------------------------

/** Characters that could forge structure or drive a terminal when printed: controls, format (bidi) characters, invisible fillers, line and paragraph separators. */
const HOSTILE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu;

/** Replace each hostile character with a visible `\uXXXX` (or `\u{X}` above the BMP) escape. */
function escapeHostile(text: string): string {
  return text.replace(HOSTILE_CHARACTERS, (character) => {
    const code = character.codePointAt(0) as number;
    return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

/**
 * Render an arbitrary value for an error message without throwing. Strings
 * are quoted, cut at 48 characters, and have control, line-separator and
 * bidi/format characters escaped, so a caller-supplied string cannot forge a
 * second line, recolor a terminal, or reorder the text around it. Objects,
 * functions and arrays are described by kind and never stringified, so a
 * hostile `toString`/`toJSON`, a cycle, or a `BigInt` cannot make the error
 * path itself throw.
 */
export function show(value: unknown): string {
  if (typeof value === "string") {
    return escapeHostile(JSON.stringify(value.length > 48 ? `${value.slice(0, 48)}...` : value));
  }
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  if (typeof value === "object") return "an object";
  if (typeof value === "function") return "a function";
  if (typeof value === "symbol") return escapeHostile(value.toString());
  // Only number | boolean | undefined | bigint remain, none of which stringify
  // through Object's default ("[object Object]") toString — verified by
  // no-unnecessary-type-assertion, which confirms TS has already narrowed
  // `value` to exactly that union here. no-base-to-string does not trust
  // narrowing this deep through a bare `unknown` parameter and flags the
  // plain call as if `value` could still be object-like; it cannot.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(value);
}

// ---------------------------------------------------------------------------
// Number validation
// ---------------------------------------------------------------------------

/**
 * Return `value` if it is a finite number; otherwise throw `RangeError`.
 * Used on DERIVED values (a product of weights, a shrinkage term, a sum) that
 * can overflow or become `NaN` even when every input was individually valid.
 * `what` names the derived quantity in the message.
 */
export function assertFinite(value: number, what: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(
      `trust-core: ${what} is not a finite number (got ${show(value)}); an input is too large for double-precision arithmetic`,
    );
  }
  return value;
}

export interface NumberRules {
  /** Inclusive lower bound (exclusive when `minExclusive`). */
  min?: number;
  /** Inclusive upper bound. */
  max?: number;
  minExclusive?: boolean;
  /** Accept `Infinity` / `-Infinity` (NaN is never accepted). */
  allowInfinity?: boolean;
}

/**
 * Return `value` if it is a number that satisfies `rules`; otherwise throw
 * `TypeError` (not a number) or `RangeError` (NaN, infinite, or out of range).
 * `label` names the thing being checked and leads the message.
 */
export function checkNumber(value: unknown, label: string, rules: NumberRules = {}): number {
  const { min, max, minExclusive = false, allowInfinity = false } = rules;
  if (typeof value !== "number") {
    throw new TypeError(`${label} must be a number (got ${show(value)})`);
  }
  const outOfRange =
    Number.isNaN(value) ||
    (!allowInfinity && !Number.isFinite(value)) ||
    (min !== undefined && (minExclusive ? value <= min : value < min)) ||
    (max !== undefined && value > max);
  if (outOfRange) {
    const kind = allowInfinity ? "a number" : "a finite number";
    let bounds = "";
    if (min !== undefined && max !== undefined) bounds = ` between ${min} and ${max}`;
    else if (min !== undefined) bounds = minExclusive ? ` > ${min}` : ` >= ${min}`;
    else if (max !== undefined) bounds = ` <= ${max}`;
    throw new RangeError(`${label} must be ${kind}${bounds} (got ${show(value)})`);
  }
  return value;
}

/** True for a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Throw `TypeError` unless `value` is a non-null, non-array object (class instances with fields are fine, e.g. signals). */
export function checkRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object (got ${show(value)})`);
  return value;
}

/**
 * True for a plain record: an object literal, `JSON.parse` output, or a
 * null-prototype object. Arrays, `Map`, `Set`, `Date`, `RegExp`, functions and
 * class instances are not plain. A record from another realm counts (its
 * prototype's own prototype is `null`), so config crossing a `vm` boundary
 * still works.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

/**
 * Throw `TypeError` unless `value` is a plain record ({@link isPlainObject}).
 * Use for configuration and weight maps: a `Map` or `Date` there would
 * otherwise be read as an empty record and silently fall back to defaults.
 */
export function checkPlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object (got ${show(value)})`);
  return value;
}

/** Throw `TypeError` unless `value` is an array. */
export function checkArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array (got ${show(value)})`);
  return value as readonly unknown[];
}

/**
 * Validate `value` is an array and return a DENSE COPY of it, built in one
 * indexed traversal: `length` is read once, each element is read once, and a
 * hole (`[a, , c]`, `new Array(3)`) throws `TypeError` naming the index.
 * Callers then validate and compute from the copy, so an array that changes
 * (a proxy, a getter, a concurrent mutation) cannot be read two ways, and
 * `.map`/`.forEach` (which skip holes) and `for...of` (which visits them)
 * cannot disagree about what was checked.
 */
export function snapshotArray(value: unknown, label: string): unknown[] {
  const source = checkArray(value, label);
  const length = source.length;
  const copy: unknown[] = [];
  for (let index = 0; index < length; index++) {
    if (!Object.hasOwn(source, index)) {
      throw new TypeError(`${label}[${index}] is missing (the array has a hole at index ${index})`);
    }
    copy.push(source[index]);
  }
  return copy;
}

/** Throw `TypeError` unless `value` is a string. */
export function checkString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string (got ${show(value)})`);
  return value;
}

/** Own-property test that ignores the prototype chain (`"constructor"`, `"__proto__"`, ...). */
export function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.hasOwn(object, key);
}

// ---------------------------------------------------------------------------
// Config shapes
// ---------------------------------------------------------------------------

/**
 * Validate a weight map (a plain record whose every own value is a finite
 * number `>= 0`) and return a fresh copy built from the values it validated.
 * A key named `__proto__` is kept as an ordinary own key.
 */
export function snapshotWeightMap(map: unknown, label: string): Record<string, number> {
  const record = checkPlainRecord(map, label);
  return Object.fromEntries(
    Object.entries(record).map(([key, weight]) => [key, checkNumber(weight, `${label}[${show(key)}]`, { min: 0 })]),
  );
}

/**
 * Shallow-merge an optional override section over `defaults`. `undefined`
 * (and only `undefined`) means "no override". Any other value must be a plain
 * record, and is validated BEFORE it is spread, so `false`, `0`, `null`, an
 * array, a `Date` or a `Map` can never vanish into the defaults.
 */
export function mergeSection(defaults: object, override: unknown, label: string): Record<string, unknown> {
  return override === undefined ? { ...defaults } : { ...defaults, ...checkPlainRecord(override, label) };
}

/** Throw `TypeError` if `object` has a key outside `allowed` (catches typos like `halflifeDays`). */
export function rejectUnknownKeys(object: object, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`${label}: unknown key ${show(key)} (allowed: ${allowed.join(", ")})`);
    }
  }
}

const RECENCY_CURVE_KEYS = ["halfLifeDays", "missingDateAgeDays"] as const;

/**
 * `halfLifeDays >= 0` (`Infinity` means "never decays"), `missingDateAgeDays >= 0`.
 * Returns a fresh copy of the validated values.
 */
export function checkRecencyCurve(curve: unknown, label: string): { halfLifeDays: number; missingDateAgeDays: number } {
  const record = checkPlainRecord(curve, label);
  rejectUnknownKeys(record, RECENCY_CURVE_KEYS, label);
  return {
    halfLifeDays: checkNumber(record.halfLifeDays, `${label}.halfLifeDays`, { min: 0, allowInfinity: true }),
    missingDateAgeDays: checkNumber(record.missingDateAgeDays, `${label}.missingDateAgeDays`, { min: 0 }),
  };
}

const THRESHOLDS_KEYS = ["high", "moderate"] as const;

/** `high` and `moderate` are numbers >= 0 (`Infinity` allowed) with `moderate <= high`. */
export function checkThresholds(thresholds: unknown, label: string): { high: number; moderate: number } {
  const record = checkPlainRecord(thresholds, label);
  rejectUnknownKeys(record, THRESHOLDS_KEYS, label);
  const high = checkNumber(record.high, `${label}.high`, { min: 0, allowInfinity: true });
  const moderate = checkNumber(record.moderate, `${label}.moderate`, { min: 0, allowInfinity: true });
  if (moderate > high) {
    throw new RangeError(`${label}.moderate (${moderate}) must not exceed ${label}.high (${high})`);
  }
  return { high, moderate };
}

/** Freeze `value` and everything reachable from it. Returns `value`. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Clock readings: a strict ISO 8601 string, or a `Date`
// ---------------------------------------------------------------------------

/**
 * Accept a "now"/"as of" clock reading as either a strict ISO 8601 string
 * ({@link checkTimestamp}) or a `Date`, and return the ISO string form used
 * internally. A `Date` is accepted here — like claims-registry-kit and
 * freshness-kit's `now: Date` — so a caller who already has one (`new
 * Date()`) doesn't have to stringify it themselves; per-signal timestamps
 * (`occurredAt`, `publishedAt`) stay string-only, since those are typically
 * read from storage already serialized. Throws `TypeError` if `value` is
 * neither a `Date` nor a string, `RangeError` for an invalid `Date` (`new
 * Date("nonsense")`) or a malformed string (see {@link checkTimestamp}).
 */
export function checkClock(value: unknown, label: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new RangeError(`${label} must be a valid Date (got an Invalid Date)`);
    }
    return value.toISOString();
  }
  // checkTimestamp returns parsed epoch milliseconds, not the string itself;
  // it throws on anything that isn't a valid ISO 8601 string, so once it
  // returns without throwing, `value` is known to be that valid string.
  checkTimestamp(value, label);
  return value as string;
}

// ---------------------------------------------------------------------------
// Strict ISO 8601 timestamps
// ---------------------------------------------------------------------------

const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2}))?$/;

const MS_PER_MINUTE = 60_000;

/**
 * Parse `YYYY-MM-DD` (read as midnight UTC) or `YYYY-MM-DDTHH:mm[:ss[.fff]]`
 * followed by `Z` or a `+HH:MM` / `-HH:MM` offset, and return milliseconds
 * since the Unix epoch.
 *
 * Deliberately stricter than `Date.parse`: a date-time WITHOUT an offset is
 * rejected (`Date.parse` would read it in the process's local zone, so the same
 * string would score differently on different machines), impossible calendar
 * dates such as `2026-02-30` are rejected (`Date.parse` rolls them forward),
 * and non-ISO strings such as `"June 1, 2026"` or `"1"` are rejected. Anything
 * past millisecond precision in the fraction is truncated. The pattern is
 * anchored and every quantifier is bounded, so long junk input fails in
 * linear time.
 */
export function checkTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be an ISO 8601 timestamp string (got ${show(value)})`);
  }
  const fail = (): never => {
    throw new RangeError(
      `${label} must be an ISO 8601 timestamp: YYYY-MM-DD, or YYYY-MM-DDTHH:mm[:ss[.sss]] followed by Z or ` +
        `a +HH:MM offset (got ${show(value)})`,
    );
  };
  const m = ISO_TIMESTAMP.exec(value);
  if (!m) return fail();

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const millis = m[7] === undefined ? 0 : Number(`${m[7]}00`.slice(0, 3));
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return fail();

  let offsetMinutes = 0;
  const zone = m[8];
  if (zone !== undefined && zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return fail();
    offsetMinutes = (zone.startsWith("-") ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  }

  // setUTCFullYear (unlike Date.UTC) does not remap years 0-99 to 1900-1999.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return fail();
  date.setUTCHours(hour, minute, second, millis);
  return date.getTime() - offsetMinutes * MS_PER_MINUTE;
}

// ---------------------------------------------------------------------------
// Exact summation
// ---------------------------------------------------------------------------

/**
 * Sum finite numbers with a single rounding at the end (Shewchuk's algorithm,
 * the same one behind Python's `math.fsum`). The result is the correctly
 * rounded value of the exact real sum, so it depends only on WHICH numbers are
 * summed, never on their order, and it does not drift as the count grows.
 *
 * Throws `RangeError` if any term is not finite (a lone `Infinity` or `NaN` is
 * rejected too, not just one that overflows mid-sum) or if an intermediate
 * value overflows to infinity. An empty list sums to `0`.
 */
export function exactSum(values: readonly number[]): number {
  const partials: number[] = [];
  for (const value of values) {
    let x = assertFinite(value, "a term being summed");
    let used = 0;
    for (let j = 0; j < partials.length; j++) {
      let y = partials[j] as number;
      if (Math.abs(x) < Math.abs(y)) {
        const swap = x;
        x = y;
        y = swap;
      }
      const hi = x + y;
      if (!Number.isFinite(hi)) throw new RangeError("trust-core: floating-point overflow while summing weights");
      const lo = y - (hi - x);
      if (lo !== 0) partials[used++] = lo;
      x = hi;
    }
    partials.length = used;
    partials.push(x);
  }

  let n = partials.length;
  if (n === 0) return 0;
  n -= 1;
  let hi = partials[n] as number;
  let lo = 0;
  while (n > 0) {
    const x = hi;
    n -= 1;
    const y = partials[n] as number;
    hi = x + y;
    lo = y - (hi - x);
    if (lo !== 0) break;
  }
  // Round-half-even correction when the discarded tail sits exactly on a tie.
  if (n > 0 && ((lo < 0 && (partials[n - 1] as number) < 0) || (lo > 0 && (partials[n - 1] as number) > 0))) {
    const y = lo * 2;
    const x = hi + y;
    if (y === x - hi) hi = x;
  }
  return hi === 0 ? 0 : hi; // normalize -0
}
