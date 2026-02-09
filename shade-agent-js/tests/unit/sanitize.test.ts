import { describe, it, expect } from "vitest";
import { sanitize, toThrowable } from "../../src/utils/sanitize";

describe("sanitize utils", () => {
  describe("sanitize", () => {
    it("sanitizes strings - replaces ed25519/secp256k1 and keyword redaction", () => {
      expect(sanitize("Error: key ed25519:5J7Xn8bB3dF2gH9kL failed")).toContain(
        "[REDACTED]",
      );
      expect(
        sanitize("Error: key ed25519:5J7Xn8bB3dF2gH9kL failed"),
      ).not.toContain("ed25519:5J7Xn");
      expect(sanitize("secret_key validation failed")).toBe("[REDACTED]");
      expect(sanitize("Failed to fund agent account")).toBe(
        "Failed to fund agent account",
      );
    });

    it("returns null/undefined as-is", () => {
      expect(sanitize(null)).toBe(null);
      expect(sanitize(undefined)).toBe(undefined);
    });

    it("sanitizes objects - redacts sensitive keys", () => {
      const result = sanitize({
        accountId: "test.testnet",
        privateKey: "ed25519:5J7Xn8bB3dF2gH9kL",
      }) as Record<string, unknown>;
      expect(result.accountId).toBe("test.testnet");
      expect(result.privateKey).toBe("[REDACTED]");
    });

    it("sanitizes objects - redacts nested sensitive keys", () => {
      const result = sanitize({
        user: { name: "alice", secretKey: "ed25519:leaked" },
      }) as Record<string, unknown>;
      expect((result.user as Record<string, unknown>).name).toBe("alice");
      expect((result.user as Record<string, unknown>).secretKey).toBe(
        "[REDACTED]",
      );
    });

    it("sanitizes string with secp256k1 pattern only", () => {
      expect(sanitize("Key secp256k1:5Kb8kLf9zg5QZ4mN3vB2xC6yT7")).toContain(
        "[REDACTED]",
      );
      expect(
        sanitize("Key secp256k1:5Kb8kLf9zg5QZ4mN3vB2xC6yT7"),
      ).not.toContain("secp256k1:");
    });

    it("returns primitives that cannot contain keys as-is", () => {
      expect(sanitize(42)).toBe(42);
      expect(sanitize(true)).toBe(true);
      expect(sanitize(42n)).toBe(42n);
      const sym = Symbol("x");
      expect(sanitize(sym)).toBe(sym);
    });

    it("sanitizes Error - returns new Error with sanitized message", () => {
      const result = sanitize(
        new Error("Invalid key ed25519:5J7Xn8bB3dF2gH9kL"),
      ) as Error;
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toContain("[REDACTED]");
      expect(result.message).not.toContain("ed25519:");
    });
  });

  describe("toThrowable", () => {
    it("sanitizes Error with private key in message", () => {
      const error = new Error(
        "Invalid key ed25519:5J7Xn8bB3dF2gH9kL1mN4pQ7rStU3vW6xY9zA2bC5dE8fGhJkLmN",
      );
      const sanitized = toThrowable(error);
      expect(sanitized.message).toContain("[REDACTED]");
      expect(sanitized.message).not.toContain("ed25519:5J7Xn");
    });

    it("handles string errors", () => {
      const sanitized = toThrowable(
        "ed25519:5J7Xn8bB3dF2gH9kL1mN4pQ7rStU3vW6xY9zA2bC5dE8fGhJkLmN",
      );
      expect(sanitized.message).toContain("[REDACTED]");
    });

    it("handles non-Error objects", () => {
      const sanitized = toThrowable({ foo: "bar" });
      expect(sanitized.message).toBe('{"foo":"bar"}');
    });

    it("uses fallback when sanitized message is empty", () => {
      const sanitized = toThrowable(new Error(""));
      expect(sanitized.message).toBe("An error occurred");
    });

    it("handles primitives via string fallback", () => {
      const sanitized = toThrowable(42);
      expect(sanitized.message).toBe("42");
    });

    it("uses fallback when sanitized result stringifies to empty", () => {
      const sanitized = toThrowable("");
      expect(sanitized.message).toBe("An error occurred");
    });

    it("sanitizes complex error with multiple sensitive patterns", () => {
      const error = new Error(
        "Add keys failed: invalid privateKey ed25519:5J7Xn8bB3dF2gH9kL1mN4pQ7rStU3vW6xY9zA2bC5dE8fGhJkLmN and secp256k1:5Kb8kLf9zg5QZ4mN3vB2xC6yT7wR1sAp9qU8iH7jG6fD5sA4kL",
      );
      const sanitized = toThrowable(error);
      // Contains privateKey keyword → whole message redacted
      expect(sanitized.message).toBe("[REDACTED]");
      expect(sanitized.message).not.toContain("ed25519:");
      expect(sanitized.message).not.toContain("secp256k1:");
      expect(sanitized.message).not.toContain("privateKey");
    });

    it("sanitizes AggregateError with sensitive message", () => {
      const inner = new Error("Inner failure");
      const aggregate = new AggregateError(
        [inner],
        "secret_key validation failed for ed25519:5J7Xn8bB3dF2gH9kL",
      );
      const sanitized = toThrowable(aggregate);
      expect(sanitized.message).toBe("[REDACTED]");
      expect(sanitized.message).not.toContain("ed25519:");
      expect(sanitized.message).not.toContain("secret_key");
    });

    it("sanitizes deep error with cause chain - only top message is extracted and sanitized", () => {
      const innermost = new Error("innermost secretKey: ed25519:leaked1");
      const inner = new Error("inner private_key: ed25519:leaked2");
      (inner as Error & { cause?: unknown }).cause = innermost;
      const outer = new Error("outer ed25519:5J7Xn8bB3dF2gH9kL failed");
      (outer as Error & { cause?: unknown }).cause = inner;
      const sanitized = toThrowable(outer);
      // Only outer.message is extracted and sanitized
      expect(sanitized.message).toContain("[REDACTED]");
      expect(sanitized.message).not.toContain("ed25519:");
      // Inner error messages are never included
      expect(sanitized.message).not.toContain("secretKey");
      expect(sanitized.message).not.toContain("private_key");
      expect(sanitized.message).not.toContain("leaked1");
      expect(sanitized.message).not.toContain("leaked2");
    });

    it("sanitizes object errors with nested sensitive keys", () => {
      const objError = {
        message: "Config validation failed",
        config: {
          privateKey:
            "ed25519:5J7Xn8bB3dF2gH9kL1mN4pQ7rStU3vW6xY9zA2bC5dE8fGhJkLmN",
          accountId: "test.testnet",
        },
      };
      const sanitized = toThrowable(objError);
      expect(sanitized.message).not.toContain("ed25519:");
      expect(sanitized.message).not.toContain("5J7Xn8bB3dF2gH9kL");
      expect(sanitized.message).toContain("[REDACTED]");
      expect(sanitized.message).toContain("test.testnet");
    });

    it("sanitizes object errors with secretKey in nested object", () => {
      const objError = {
        error: "Key derivation failed",
        details: {
          secret_key:
            "secp256k1:5Kb8kLf9zg5QZ4mN3vB2xC6yT7wR1sAp9qU8iH7jG6fD5sA4kL",
        },
      };
      const sanitized = toThrowable(objError);
      expect(sanitized.message).not.toContain("secp256k1:");
      expect(sanitized.message).not.toContain("5Kb8kLf9zg5QZ4mN");
      expect(sanitized.message).toContain("[REDACTED]");
    });
  });
});
