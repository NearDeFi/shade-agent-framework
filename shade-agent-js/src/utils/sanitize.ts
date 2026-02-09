/**
 * Sanitization utilities to prevent private key leaks in error messages and logs.
 */

import { DeepRedact } from "@hackylabs/deep-redact/index.ts";

const REDACTED = "[REDACTED]";

const SENSITIVE_KEYS = ["privateKey", "private_key", "secretKey", "secret_key"];

const deepRedact = new DeepRedact({
  serialise: false,
  blacklistedKeys: SENSITIVE_KEYS,
  stringTests: [
    {
      pattern: /privateKey|private_key|secretKey|secret_key/i,
      replacer: () => REDACTED,
    },
    {
      pattern: /ed25519:[^\s]+/g,
      replacer: (value: string, pattern: RegExp) =>
        value.replace(pattern, REDACTED),
    },
    {
      pattern: /secp256k1:[^\s]+/g,
      replacer: (value: string, pattern: RegExp) =>
        value.replace(pattern, REDACTED),
    },
  ],
});

/**
 * Sanitizes any value: strings, objects, Errors, and primitives.
 * Redacts private key patterns and sensitive keys (privateKey, secretKey, etc.).
 * Returns values that cannot contain a private key as-is.
 *
 * - string → sanitized string
 * - Error → new Error with sanitized message
 * - object/array → redacted copy
 * - null/undefined/number/boolean/symbol/bigint → returned as-is
 */
export function sanitize(value: unknown): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    return value;
  }

  if (typeof value === "string") {
    const result = deepRedact.redact(value);
    return String(result);
  }

  if (value instanceof Error) {
    const result = deepRedact.redact(value.message);
    return new Error(String(result) || "An error occurred");
  }

  if (typeof value === "object") {
    const result = deepRedact.redact(value) as object;
    return typeof result === "object" && result !== null ? result : {};
  }

  return value;
}

/** Returns an Error suitable for throwing. Use: throw toThrowable(caughtError) */
export function toThrowable(error: unknown): Error {
  const result = sanitize(error);
  if (result instanceof Error) return result;
  if (typeof result === "object" && result !== null) {
    return new Error(JSON.stringify(result));
  }
  return new Error(String(result) || "An error occurred");
}
