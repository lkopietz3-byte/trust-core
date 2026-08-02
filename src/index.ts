/**
 * trust-core — two complementary lenses on entity trust, built from one
 * shared toolkit. See README.md for the full API and runnable examples.
 *
 *   import { identified, anonymous } from "trust-core";
 *   // or, for a smaller import graph:
 *   import { scoreEntity } from "trust-core/identified";
 *   import { assessAuthenticity } from "trust-core/anonymous";
 */

export * from "./shared/types.js";
export * as identified from "./identified/index.js";
export * as anonymous from "./anonymous/index.js";
