/**
 * Unit tests for src/utils/placeholders.js
 *
 * Coverage:
 *  - replacePlaceholders on a JSON string: substitutes string + non-string
 *    values correctly (uses JSON.stringify), parses the result, returns object.
 *  - replacePlaceholders on an already-parsed object: recursive substitution
 *    in nested objects and arrays.
 *  - Returns input unchanged when the placeholder is absent.
 *  - Bails (process.exit(1)) when the post-substitution string is invalid JSON.
 *
 * Notes:
 *  - process.exit is spied so failure-path tests can assert it was called
 *    instead of really terminating the test runner.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { replacePlaceholders } from "../../src/utils/placeholders.js";

describe("replacePlaceholders", () => {
  afterEach(() => vi.restoreAllMocks());

  // String args: an UNQUOTED placeholder for a string value is replaced via
  // JSON.stringify(value) (which adds the surrounding quotes), and the
  // result is JSON.parsed back into an object. The example deployment YAMLs
  // (see example-3.yaml) don't quote placeholders for this reason.
  it("substitutes an unquoted-placeholder for a string value via JSON.stringify", () => {
    const out = replacePlaceholders('{"id": <ID>}', { "<ID>": "alice.near" });
    expect(out).toEqual({ id: "alice.near" });
  });

  // String args with an UNQUOTED placeholder for a non-string value: the
  // placeholder is replaced via JSON.stringify(value), so a number 5 emits
  // as `5` (no quotes) and parses to a number.
  it("substitutes an unquoted-placeholder for a number value", () => {
    const out = replacePlaceholders('{"n": <N>}', { "<N>": 5 });
    expect(out).toEqual({ n: 5 });
  });

  // Multiple occurrences of the same placeholder in a JSON string are all
  // replaced.
  it("substitutes multiple occurrences of the same placeholder", () => {
    const out = replacePlaceholders("[<X>, <X>]", { "<X>": 7 });
    expect(out).toEqual([7, 7]);
  });

  // Already-parsed object input: recursive replacement on nested values
  // (objects + arrays).
  it("recursively substitutes placeholders in nested objects/arrays", () => {
    const input = { a: { b: "<NAME>" }, c: ["<NAME>", "static"] };
    const out = replacePlaceholders(input, { "<NAME>": "bob" });
    expect(out).toEqual({ a: { b: "bob" }, c: ["bob", "static"] });
  });

  // Replacements whose placeholder doesn't appear in args do nothing.
  it("returns input unchanged when the placeholder is absent", () => {
    const out = replacePlaceholders({ a: "literal" }, { "<UNUSED>": "x" });
    expect(out).toEqual({ a: "literal" });
  });

  // A malformed JSON string (no placeholders to fix it) hits the documented
  // process.exit(1) path with a red error log.
  it("calls process.exit(1) when the substituted string is invalid JSON", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code) => {
        throw new Error(`exit:${code}`);
      });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => replacePlaceholders("{not json", {})).toThrow("exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
