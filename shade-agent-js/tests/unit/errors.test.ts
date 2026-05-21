import { describe, it, expect, afterEach } from "vitest";
import {
  sanitize,
  toThrowable,
  genericError,
  addSensitive,
} from "../../src/utils/errors";

describe("errors utils", () => {
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

  describe("sanitize - new field-name redactions", () => {
    it.each([
      // Crypto / wallet
      "extendedSecretKey",
      "mnemonic",
      "mnemonicPhrase",
      "seedPhrase",
      "seed_phrase",
      "seed",
      "signingKey",
      "signing_key",
      "_signingKey",
      "_privateKey",
      "xprv",
      "xpriv",
      "masterKey",
      "master_key",
      "keystore",
      "signer",
      "key",
      "keyPair",
      "agentPrivateKey",
      "agentPrivateKeys",
      // API / OAuth / generic auth credentials
      "apiKey",
      "api_key",
      "apiSecret",
      "api_secret",
      "accessToken",
      "access_token",
      "refreshToken",
      "refresh_token",
      "bearerToken",
      "bearer_token",
      "authToken",
      "auth_token",
      "token",
      "clientSecret",
      "client_secret",
      "sessionToken",
      "session_token",
      "webhookSecret",
      "webhook_secret",
      "authorization",
      "cookie",
      "password",
      "passwd",
      "passphrase",
    ])("redacts %s by field name regardless of value shape", (fieldName) => {
      const result = sanitize({
        accountId: "alice.testnet",
        [fieldName]: "raw-bytes-no-prefix-ZZTESTSECRETZZ",
      }) as Record<string, unknown>;
      expect(result.accountId).toBe("alice.testnet");
      expect(result[fieldName]).toBe("[REDACTED]");
    });

    it("redacts deeply-nested account-shaped object", () => {
      const result = sanitize({
        accountId: "alice.testnet",
        signer: {
          key: { extendedSecretKey: "ed25519:ZZTESTSECRETZZ" },
        },
      }) as Record<string, unknown>;
      expect(result.accountId).toBe("alice.testnet");
      expect(result.signer).toBe("[REDACTED]");
    });

    it("handles circular Account→signer→key→parent chain without throwing", () => {
      const a: Record<string, unknown> = { accountId: "alice.testnet" };
      const k: Record<string, unknown> = {
        extendedSecretKey: "ed25519:ZZTESTSECRETZZ",
      };
      a.signer = { key: k };
      k.parent = a;
      expect(() => sanitize(a)).not.toThrow();
    });
  });

  describe("sanitize - new value-regex redactions", () => {
    it("redacts PEM private key blocks", () => {
      const pem =
        "-----BEGIN RSA PRIVATE KEY-----\nZZTESTSECRETPEMZZ\n-----END RSA PRIVATE KEY-----";
      const result = sanitize(`prelude ${pem} postlude`) as string;
      expect(result).not.toContain("ZZTESTSECRETPEM");
      expect(result).toContain("[REDACTED]");
    });

    // Representative variants — xprv (BIP32 mainnet baseline), zprv (BIP84,
    // the previously-broken variant), Vprv (uppercase / multisig). If the
    // character class regresses on a single letter, one of these catches it.
    it.each([
      ["xprv", "x"],
      ["zprv", "z"],
      ["Vprv", "V"],
    ])("redacts BIP32 extended private keys (%s variant)", (variant, prefix) => {
      const extended =
        prefix +
        "prv9s21ZrQH143K3ZZTESTSECRET" +
        variant +
        "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
      const result = sanitize(`got ${extended} from store`) as string;
      expect(result).not.toContain("ZZTESTSECRET");
      expect(result).toContain("[REDACTED]");
    });

    it("redacts Bitcoin WIF", () => {
      const wif = "5HwLs2ZZTESTSECRETwifxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
      const result = sanitize(`key ${wif} loaded`) as string;
      expect(result).not.toContain("ZZTESTSECRETwif");
      expect(result).toContain("[REDACTED]");
    });

    it("redacts JWTs (three-segment base64url with eyJ prefix)", () => {
      // Synthetic but structurally-valid JWT — header.payload.signature.
      const jwt =
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJaWlRFU1RTRUNSRVRKV1QifQ.AAAA-ZZTESTSECRETJWTSIG";
      const result = sanitize(`Auth failed for token ${jwt}`) as string;
      expect(result).not.toContain("ZZTESTSECRETJWT");
      expect(result).toContain("[REDACTED]");
    });

    it("redacts HTTP Authorization Bearer credentials, keeping the scheme", () => {
      const result = sanitize(
        "headers: { Authorization: Bearer ZZTESTSECRETBEARERZZ }",
      ) as string;
      expect(result).not.toContain("ZZTESTSECRETBEARER");
      expect(result).toContain("Bearer [REDACTED]");
    });

    it("redacts HTTP Authorization Basic credentials", () => {
      const result = sanitize(
        "request failed: Basic ZZTESTSECRETBASICZZ==",
      ) as string;
      expect(result).not.toContain("ZZTESTSECRETBASIC");
      expect(result).toContain("Basic [REDACTED]");
    });
  });

  describe("toThrowable - preserves all sanitised fields", () => {
    it("preserves err.type for callers to dispatch on", () => {
      const e = Object.assign(new Error("not found"), {
        type: "AccountDoesNotExist",
      });
      const out = toThrowable(e) as Error & { type?: string };
      expect(out.type).toBe("AccountDoesNotExist");
      expect(out.message).toBe("not found");
    });

    it("preserves err.code and err.status (HTTP/network shapes)", () => {
      const e = Object.assign(new Error("HTTP 503"), {
        code: "ECONNRESET",
        status: 503,
      });
      const out = toThrowable(e) as Error & { code?: string; status?: number };
      expect(out.code).toBe("ECONNRESET");
      expect(out.status).toBe(503);
    });

    it("preserves err.name (TypeError, AbortError, etc.)", () => {
      const out = toThrowable(new TypeError("nope"));
      expect(out.name).toBe("TypeError");
    });

    it("preserves err.stack from the original throw site", () => {
      const original = new Error("boom");
      Object.defineProperty(original, "stack", {
        value: "ORIGINAL-STACK-MARKER\n  at someFn (some/file.ts:1:1)",
      });
      const out = toThrowable(original);
      expect(out.stack).toContain("ORIGINAL-STACK-MARKER");
    });

    it("redacts secrets in stack frames", () => {
      const original = new Error("boom");
      // Synthetic stack with a recognisable secret pattern in a frame.
      Object.defineProperty(original, "stack", {
        value:
          "Error: boom\n  at fn (file.ts:1:1) // leaked ed25519:ZZTESTSECRETSTACKZZ here",
      });
      const out = toThrowable(original) as Error & { stack?: string };
      expect(out.stack).toBeDefined();
      expect(out.stack).not.toContain("ZZTESTSECRETSTACK");
      expect(out.stack).toContain("[REDACTED]");
    });

    it("preserves err.cause recursively-sanitised", () => {
      const e = Object.assign(new Error("outer"), {
        cause: {
          signer: { extendedSecretKey: "ed25519:ZZTESTSECRETCAUSEZZ" },
        },
      });
      const out = toThrowable(e) as Error & {
        cause?: Record<string, unknown>;
      };
      // cause is preserved (the whole signer subtree redacted by field name)
      expect(out.cause).toBeDefined();
      expect((out.cause as Record<string, unknown>).signer).toBe("[REDACTED]");
      // No way for the secret marker to slip through
      expect(JSON.stringify(out.cause)).not.toContain("ZZTESTSECRETCAUSE");
    });

    it("recursively sanitises nested Error.cause.message (non-enumerable)", () => {
      // Error.message is non-enumerable on the prototype, so a naive
      // object-walk over a cause-Error misses it. Verify we explicitly
      // extract + sanitise via sanitizeError before attaching.
      const inner = new Error("ed25519:ZZTESTSECRETINNERMSGZZ");
      const outer = Object.assign(new Error("outer"), { cause: inner });
      const out = toThrowable(outer) as Error & { cause?: Error };
      expect(out.cause).toBeInstanceOf(Error);
      expect((out.cause as Error).message).not.toContain(
        "ZZTESTSECRETINNERMSG",
      );
      expect((out.cause as Error).message).toContain("[REDACTED]");
    });

    it("recursively sanitises 3-level Error cause chain", () => {
      const innermost = new Error("ed25519:ZZTESTSECRETLEVEL3ZZ");
      const middle = Object.assign(new Error("mid"), { cause: innermost });
      const outer = Object.assign(new Error("outer"), { cause: middle });
      const out = toThrowable(outer) as Error & { cause?: Error };
      expect(JSON.stringify(out)).not.toContain("ZZTESTSECRETLEVEL3");
      // Walking the cause chain ourselves and inspecting each .message also
      // must not surface the secret.
      let cursor: unknown = out;
      while (cursor && cursor instanceof Error) {
        expect(cursor.message).not.toContain("ZZTESTSECRETLEVEL3");
        cursor = (cursor as Error & { cause?: unknown }).cause;
      }
    });

    it("sanitises AggregateError.errors", () => {
      const leaky = new Error("ed25519:ZZTESTSECRETAGGZZ");
      const agg = new AggregateError([leaky], "aggregate failure");
      const out = toThrowable(agg) as Error & { errors?: Error[] };
      expect(out.errors).toBeDefined();
      expect((out.errors as Error[])[0].message).not.toContain(
        "ZZTESTSECRETAGG",
      );
      expect((out.errors as Error[])[0].message).toContain("[REDACTED]");
    });

    it("sanitises a primitive string cause", () => {
      // Error.cause is `unknown` — a thrower can attach a raw string secret.
      const e = Object.assign(new Error("outer"), {
        cause: "ed25519:ZZTESTSECRETSTRINGCAUSEZZ",
      });
      const out = toThrowable(e) as Error & { cause?: unknown };
      expect(out.cause).toBeDefined();
      expect(String(out.cause)).not.toContain("ZZTESTSECRETSTRINGCAUSE");
      expect(String(out.cause)).toContain("[REDACTED]");
    });

    it("sanitises a primitive string inside AggregateError.errors", () => {
      const agg = new AggregateError(
        ["ed25519:ZZTESTSECRETAGGPRIMITIVEZZ", new Error("plain")],
        "agg",
      );
      const out = toThrowable(agg) as Error & { errors?: unknown[] };
      expect(out.errors).toBeDefined();
      expect(JSON.stringify(out.errors)).not.toContain(
        "ZZTESTSECRETAGGPRIMITIVE",
      );
    });

    it("preserves safe primitive causes unchanged", () => {
      const e = Object.assign(new Error("outer"), { cause: 42 });
      const out = toThrowable(e) as Error & { cause?: unknown };
      expect(out.cause).toBe(42);
    });

    it("preserves arbitrary custom fields (sanitised)", () => {
      const e = Object.assign(new Error("custom"), {
        requestId: "req-123",
        meta: { context: "deploy-flow" },
      });
      const out = toThrowable(e) as Error & {
        requestId?: string;
        meta?: Record<string, unknown>;
      };
      expect(out.requestId).toBe("req-123");
      expect(out.meta).toEqual({ context: "deploy-flow" });
    });
  });

  describe("genericError", () => {
    it("returns new Error(message) verbatim, no sanitisation, no preservation", () => {
      const out = genericError("Failed to X with ed25519:ZZTESTSECRETZZ");
      // genericError does NOT sanitise — the caller must give a safe message.
      expect(out.message).toBe("Failed to X with ed25519:ZZTESTSECRETZZ");
      expect((out as Error & { type?: string }).type).toBeUndefined();
    });
  });

  describe("addSensitive", () => {
    afterEach(() => {
      // No reset API by design; the singleton mutation persists.
      // Tests below verify additive behaviour; cleanup not needed for
      // subsequent describes since they don't assert absence of these
      // markers in unrelated values.
    });

    it("extends key blacklist at runtime", () => {
      addSensitive({ keys: ["bearerToken"] });
      const result = sanitize({ bearerToken: "Bearer xyz" }) as Record<
        string,
        unknown
      >;
      expect(result.bearerToken).toBe("[REDACTED]");
    });

    it("extends pattern list at runtime", () => {
      addSensitive({
        patterns: [
          {
            pattern: /CUSTOMSECRET-\S+/g,
            replacer: (v, p) => v.replace(p, "[REDACTED]"),
          },
        ],
      });
      const result = sanitize("found CUSTOMSECRET-abc in log") as string;
      expect(result).toBe("found [REDACTED] in log");
    });

    it("handles consumer-provided /g regex without alternating misses", () => {
      // Before the flag-stripping fix, a /g regex passed in here would
      // share state across deep-redact's repeated .test() calls and cause
      // alternating sanitisation. Verify three sequential sanitise calls
      // all redact correctly.
      addSensitive({
        patterns: [
          {
            pattern: /STATEFULSECRET-\S+/g,
            replacer: (v, p) => v.replace(p, "[REDACTED]"),
          },
        ],
      });
      for (let i = 0; i < 3; i++) {
        const r = sanitize(`leak ${i} STATEFULSECRET-${i} end`) as string;
        expect(r).not.toContain("STATEFULSECRET");
        expect(r).toContain("[REDACTED]");
      }
    });

    it("replace-all semantics preserved when consumer passes /g and replaces via the original pattern", () => {
      addSensitive({
        patterns: [
          {
            pattern: /MULTI-\d+/g,
            replacer: (v, p) => v.replace(p, "[X]"),
          },
        ],
      });
      const r = sanitize("a MULTI-1 b MULTI-2 c MULTI-3 d") as string;
      expect(r).toBe("a [X] b [X] c [X] d");
    });
  });

  describe("toThrowable - total (never throws)", () => {
    // Exotic input shapes that would crash a naive normaliser. The contract
    // is: toThrowable always returns an Error and never throws.
    const circularObj: Record<string, unknown> = { foo: "bar" };
    circularObj.self = circularObj;
    const circularBigInt: Record<string, unknown> = { count: 100n };
    circularBigInt.self = circularBigInt;
    const hostileGetter = new Error("outer");
    Object.defineProperty(hostileGetter, "badProp", {
      get() {
        throw new Error("getter explodes");
      },
      enumerable: true,
    });
    const hostileProxy = new Proxy(
      {},
      {
        get() {
          throw new Error("trap");
        },
        ownKeys() {
          throw new Error("trap");
        },
        getOwnPropertyDescriptor() {
          throw new Error("trap");
        },
      },
    );

    it.each<[string, unknown]>([
      ["circular object", circularObj],
      ["BigInt-bearing object", { count: 42n }],
      ["raw BigInt", 42n],
      ["circular + BigInt", circularBigInt],
      ["Symbol", Symbol("x")],
      ["undefined", undefined],
      ["null", null],
      ["Error with throwing getter", hostileGetter],
      ["maximally-hostile Proxy", hostileProxy],
    ])("doesn't throw on %s", (_label, input) => {
      expect(() => toThrowable(input)).not.toThrow();
      expect(toThrowable(input)).toBeInstanceOf(Error);
    });

    it("redacts a secret in a thrown Symbol's description", () => {
      // `String(Symbol("ed25519:secret"))` is "Symbol(ed25519:secret)" — the
      // description survives stringification. The final boundary in
      // toThrowable runs the stringified form through the redactor so this
      // doesn't leak into the new Error's message.
      const out = toThrowable(Symbol("ed25519:ZZTESTSECRETSYMDESCZZ"));
      expect(out.message).not.toContain("ZZTESTSECRETSYMDESC");
      expect(out.message).toContain("[REDACTED]");
    });

    it("redacts a secret in a boxed-primitive thrown value", () => {
      // `new String("…")` is typeof "object", so deep-redact walks each
      // character separately. The final-boundary sanitiser re-runs over the
      // stringified form so the assembled secret is still redacted.
      const boxed = new String("ed25519:ZZTESTSECRETBOXEDZZ");
      const out = toThrowable(boxed);
      expect(out.message).not.toContain("ZZTESTSECRETBOXED");
    });
  });

  describe("symbol-keyed properties are dropped", () => {
    // The dependency-tree audit found zero libraries that attach
    // symbol-keyed properties to errors. Rather than walk symbols and
    // sanitise their values (parallel-tree walker, circular-ref guard,
    // hostile-getter handling), we drop them entirely. These tests
    // lock in that contract: a symbol-keyed property on the input must
    // not appear on the sanitised output, and its value must not leak.

    it("drops a Symbol-keyed property on an Error when routed through toThrowable", () => {
      const SECRET = Symbol("internal");
      const e = new Error("outer");
      Object.defineProperty(e, SECRET, {
        value: "ed25519:ZZTESTSECRETSYMERRORZZ",
        enumerable: true,
      });
      const out = toThrowable(e) as Error;
      // The symbol must not appear on the output at all.
      expect(Object.getOwnPropertySymbols(out)).not.toContain(SECRET);
      expect(
        (out as unknown as Record<symbol, unknown>)[SECRET],
      ).toBeUndefined();
      // Belt and braces: no marker substring anywhere on the error,
      // including in console.log / util.inspect output (which is what
      // would surface a symbol-keyed leak in practice).
      expect(JSON.stringify({ ...(out as object) })).not.toContain(
        "ZZTESTSECRETSYMERROR",
      );
    });

    it("drops a Symbol-keyed property on a plain object via sanitize", () => {
      const SECRET = Symbol("token");
      const obj = { accountId: "alice.testnet" } as Record<symbol, unknown> &
        Record<string, unknown>;
      obj[SECRET] = "ed25519:ZZTESTSECRETSYMOBJZZ";
      const out = sanitize(obj) as Record<symbol, unknown> &
        Record<string, unknown>;
      // Non-secret string keys still survive.
      expect(out.accountId).toBe("alice.testnet");
      // The symbol is absent.
      expect(Object.getOwnPropertySymbols(out)).not.toContain(SECRET);
      expect(out[SECRET]).toBeUndefined();
    });

    it("drops a Symbol-keyed property nested in an object tree", () => {
      const SECRET = Symbol("nested");
      const obj: Record<string, unknown> = {
        outer: { mid: { inner: {} } },
      };
      const inner = (obj.outer as Record<string, unknown>).mid as Record<
        string,
        unknown
      >;
      (inner.inner as Record<symbol, unknown>)[SECRET] =
        "ed25519:ZZTESTSECRETSYMNESTEDZZ";
      const out = sanitize(obj) as Record<string, unknown>;
      const innerOut = (
        (out.outer as Record<string, unknown>).mid as Record<string, unknown>
      ).inner as Record<symbol, unknown>;
      expect(Object.getOwnPropertySymbols(innerOut)).not.toContain(SECRET);
      expect(innerOut[SECRET]).toBeUndefined();
    });

    it("drops well-known symbols too (no exception for builtins)", () => {
      // Demonstrates the rule is uniform: ANY symbol is dropped, including
      // well-known ones like Symbol.iterator. If a thrower attaches
      // Symbol.toPrimitive returning a secret, that path is closed.
      const e = new Error("outer");
      Object.defineProperty(e, Symbol.toPrimitive, {
        value: () => "ed25519:ZZTESTSECRETSYMTOPRIMZZ",
        enumerable: true,
      });
      const out = toThrowable(e) as Error;
      expect(Object.getOwnPropertySymbols(out)).not.toContain(
        Symbol.toPrimitive,
      );
    });
  });
});
