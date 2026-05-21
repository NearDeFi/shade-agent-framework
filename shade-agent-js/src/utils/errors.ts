/**
 * Error / sanitisation utilities. The single trust boundary for secret leak
 * prevention in shade-agent-js: every catch in the package should rethrow
 * via `toThrowable(e)` so that sensitive fields and recognised secret value
 * patterns are redacted before the error escapes.
 *
 * Fail-closed rule: if any value can't be safely processed (hostile getter,
 * throwing Proxy, deep-redact crash, …), it is replaced with the
 * `[unsanitisable]` placeholder string so operators can see that
 * something was there but couldn't be sanitised. The unsanitised
 * original is NEVER propagated. The only exception is the final
 * `toThrowable` boundary, which must return a real Error — there it
 * falls back to a generic "An error occurred" message.
 *
 * File layout — six sections, top to bottom:
 *   1. Redaction policy   — which field names + value patterns count as secrets.
 *   2. Redactor engine    — the mutable deep-redact instance + extension API.
 *   3. Sanitiser          — walks any value, redacts secrets, marks unsanitisables.
 *   4. Public throw API   — toThrowable + genericError.
 *   5. Retry              — defaultRetryable + withRetry + helpers.
 *   6. Safe key parsing   — safeParseKeyPair / safeParseSigner.
 */

import { DeepRedact } from "@hackylabs/deep-redact/index.ts";
import { KeyPair, KeyPairString } from "@near-js/crypto";
import { KeyPairSigner } from "@near-js/signers";


// ===========================================================================
// SECTION 1 — REDACTION POLICY
// ===========================================================================
// What counts as a secret. Two independent mechanisms:
//   1. Field-name redaction: if a property KEY matches any of SHADE_REDACT_KEYS,
//      the VALUE under that key is replaced with [REDACTED] regardless of type.
//   2. Value-pattern redaction: if a STRING anywhere in the input matches one
//      of SHADE_REDACT_PATTERNS, the matched substring is replaced.

/** Placeholder used in place of a recognised secret value. */
const REDACTED = "[REDACTED]";

/**
 * Placeholder used in place of any value the sanitiser couldn't process
 * (hostile getter, throwing Proxy, deep-redact crash, …). Used uniformly
 * everywhere a value can't be handled, so the unsanitised original
 * never propagates but operators still see that something was there.
 */
const UNSANITISABLE = "[unsanitisable]";

/**
 * Property keys whose value is always redacted, regardless of value type.
 * Catches a leak like `err.signer = keyPair` even if the inner KeyPair
 * doesn't contain any string that matches a value pattern below.
 */
const SHADE_REDACT_KEYS: string[] = [
  // NEAR
  "privateKey",
  "private_key",
  "secretKey",
  "secret_key",
  "extendedSecretKey", // @near-js KeyPair public field
  "signer", // @near-js Account.signer
  "key", // @near-js KeyPairSigner.key
  "keyPair",
  "agentPrivateKey",
  "agentPrivateKeys",
  // BIP39 / mnemonics
  "mnemonic",
  "mnemonicPhrase",
  "seedPhrase",
  "seed_phrase",
  "seed",
  // ethers / EVM internals
  "signingKey",
  "signing_key",
  "_signingKey",
  "_privateKey",
  // BIP32 hierarchical
  "xprv",
  "xpriv",
  "masterKey",
  "master_key",
  // Encrypted keystores
  "keystore",
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
  "authorization", // HTTP Authorization header field
  "cookie", // session cookies / auth cookies
  // Passwords
  "password",
  "passwd",
  "passphrase",
];

/** Shape of a value-pattern entry: a regex to test, plus a replacer function. */
interface StringTest {
  pattern: RegExp;
  replacer: (value: string, pattern: RegExp) => string;
}

/**
 * Value patterns. Any string matching one of these is redacted.
 *
 * IMPORTANT: the `pattern:` field must NOT use the /g flag. Deep-redact
 * calls `pattern.test(value)` on it; /g makes `.test` stateful via
 * `lastIndex`, so consecutive calls would alternate match/miss. The
 * `replacer:` body is unrestricted — inline /g regexes there are fine
 * and expected for replace-all semantics.
 */
const SHADE_REDACT_PATTERNS: StringTest[] = [
  // Any string containing a sensitive keyword → whole string redacted.
  {
    pattern:
      /privateKey|private_key|secretKey|secret_key|extendedSecretKey|agentPrivateKeys?/i,
    replacer: () => REDACTED,
  },
  // NEAR canonical secret-key string form → surgical substring replacement.
  {
    pattern: /ed25519:[^\s]+/,
    replacer: (v) => v.replace(/ed25519:[^\s]+/g, REDACTED),
  },
  {
    pattern: /secp256k1:[^\s]+/,
    replacer: (v) => v.replace(/secp256k1:[^\s]+/g, REDACTED),
  },
  // PEM private key blocks (TLS / SSH / PGP).
  {
    pattern:
      /-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/,
    replacer: () => REDACTED,
  },
  // BIP32 extended private keys: xprv (mainnet), tprv (testnet),
  // yprv (BIP49), zprv (BIP84), vprv (BIP86), plus uppercase multisig variants.
  {
    pattern: /\b[xytzuvXYZTUV]prv[1-9A-HJ-NP-Za-km-z]{50,108}\b/,
    replacer: () => REDACTED,
  },
  // Bitcoin WIF: `5` / `K` / `L` prefix + 50–51 base58 chars.
  {
    pattern: /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/,
    replacer: () => REDACTED,
  },
  // JSON Web Tokens (RFC 7519). Three base64url segments separated by
  // dots; first two start with "eyJ" (base64 of `{"`). Very specific
  // shape, near-zero false-positive risk.
  {
    pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
    replacer: (v) =>
      v.replace(
        /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
        REDACTED,
      ),
  },
  // HTTP Authorization header (RFC 6750/7235): "Bearer ...", "Basic ...",
  // "Token ...". Common when a library attaches request headers to an
  // error. Replaces just the credential, preserves the scheme.
  {
    pattern: /\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9_.\-+/=]+/i,
    replacer: (v) =>
      v.replace(
        /\b(Bearer|Basic|Token)\s+[A-Za-z0-9_.\-+/=]+/gi,
        `$1 ${REDACTED}`,
      ),
  },
];


// ===========================================================================
// SECTION 2 — REDACTOR ENGINE
// ===========================================================================
// Holds the active deep-redact instance. Mutable so `addSensitive()` can
// extend it with caller-defined keys and patterns at runtime.

// Active config. Starts as a copy of the defaults; addSensitive appends.
let activeKeys: string[] = [...SHADE_REDACT_KEYS];
let activePatterns: StringTest[] = [...SHADE_REDACT_PATTERNS];
let deepRedact = build(activeKeys, activePatterns);

/**
 * Construct a fresh DeepRedact instance with the given config.
 * `types: ["string", "object"]` covers both string-valued and object-valued
 * blacklisted-key matches; arrays count as objects under `typeof`.
 */
function build(keys: string[], patterns: StringTest[]) {
  return new DeepRedact({
    serialise: false,
    blacklistedKeys: keys,
    stringTests: patterns,
    types: ["string", "object"],
  });
}

/**
 * Remove the stateful flags `g` and `y` from a regex. Deep-redact uses
 * `pattern.test(value)` which is stateful on /g/y regexes — consecutive
 * calls would alternate match/miss. We use this on caller-provided
 * patterns. The original (with /g) is preserved separately so a
 * consumer's `.replace(p, X)` for replace-all still works.
 */
function stripStatefulFlags(re: RegExp): RegExp {
  if (!/[gy]/.test(re.flags)) return re;
  return new RegExp(re.source, re.flags.replace(/[gy]/g, ""));
}

/**
 * Extend the redaction config at runtime. After this returns, subsequent
 * sanitize/toThrowable calls also redact the new field names and apply
 * the new value patterns. Mutation is process-global — call once at boot.
 */
export function addSensitive(opts: {
  keys?: string[];
  patterns?: StringTest[];
}): void {
  if (opts.keys?.length) activeKeys = [...activeKeys, ...opts.keys];
  if (opts.patterns?.length) {
    const safe: StringTest[] = opts.patterns.map((p) => {
      const original = p.pattern;
      const stripped = stripStatefulFlags(original);
      if (stripped === original) return p;
      return {
        pattern: stripped,
        // Caller's replacer keeps access to the original (flagged) regex.
        replacer: (v) => p.replacer(v, original),
      };
    });
    activePatterns = [...activePatterns, ...safe];
  }
  deepRedact = build(activeKeys, activePatterns);
}

// ===========================================================================
// SECTION 3 — SANITISER
// ===========================================================================
// Walks any value, redacts secrets via deep-redact, and marks anything
// it can't safely process with the [unsanitisable] placeholder. The
// rule is uniform: a hostile getter, a throwing Proxy, a recursive
// structure deep-redact can't handle — every such case results in the
// offending field being replaced with [unsanitisable] so operators
// see that something was there but the unsanitised original never
// propagates. Symbol-keyed properties are an exception: dropped
// entirely (the dependency-tree audit found no library uses them).

/**
 * Sanitise an Error into a fresh Error instance.
 *
 * What survives:
 *   - sanitised `message` (or "An error occurred" if empty)
 *   - sanitised string-keyed own properties (`name`, `type`, `code`,
 *     `status`, `stack`, anything custom)
 *   - recursively-sanitised `cause` and (for AggregateError) `errors`
 *
 * What gets dropped:
 *   - symbol-keyed own properties — dropped unconditionally. The
 *     dependency-tree audit found no library that uses symbol keys on
 *     errors, so dropping is fail-closed by construction.
 *   - any string-keyed field whose read throws (hostile getter / Proxy trap)
 *   - any field whose sanitise throws
 *   - `cause` if its sanitisation fails
 *   - anything that can't be assigned to the output (frozen, read-only, …)
 */
function sanitizeError(error: Error): Error {
  try {
    // ---- Pre-extract `cause` and `errors` (handled out-of-band so nested
    // Errors don't get flattened by deep-redact's object transformer).
    let sanitisedCause: unknown;
    let hasCause = false;
    if ("cause" in error) {
      try {
        sanitisedCause = sanitize(
          (error as Error & { cause?: unknown }).cause,
        );
      } catch {
        sanitisedCause = UNSANITISABLE;
      }
      hasCause = true;
    }
    let sanitisedErrors: unknown;
    if (error instanceof AggregateError) {
      try {
        const arr = (error as AggregateError).errors;
        if (Array.isArray(arr)) {
          sanitisedErrors = arr.map((e) => {
            try {
              return sanitize(e);
            } catch {
              return UNSANITISABLE; // mark this element
            }
          });
        } else {
          // .errors wasn't an array — mark the whole field as unsanitisable.
          sanitisedErrors = UNSANITISABLE;
        }
      } catch {
        // Couldn't even read .errors — mark the whole field as unsanitisable.
        sanitisedErrors = UNSANITISABLE;
      }
    }

    // ---- Build a plain-object bag of the Error's string-keyed own
    // properties. Symbol-keyed properties are dropped (see function-level
    // doc above). Anything that throws on read or sanitise becomes
    // [unsanitisable] so operators still see something was there.
    const own: Record<string, unknown> = {
      name: error.name,
      message: error.message ?? "",
    };
    for (const k of Object.getOwnPropertyNames(error)) {
      if (k === "cause" || k === "errors") continue;
      if (k in own) continue;
      try {
        const v = (error as unknown as Record<string, unknown>)[k];
        own[k] = sanitize(v);
      } catch {
        // Hostile getter or sanitise failure — mark as unsanitisable.
        own[k] = UNSANITISABLE;
      }
    }

    // ---- Run the redactor over the bag, then construct the output Error.
    const sanitised = deepRedact.redact(own) as Record<string, unknown>;
    const msg = String(sanitised.message ?? "");
    const out = new Error(msg || "An error occurred");

    // Copy each sanitised own property onto the output. Anything that
    // can't be assigned (read-only descriptor, …) is dropped silently.
    for (const [k, v] of Object.entries(sanitised)) {
      if (k === "message") continue;
      try {
        Object.defineProperty(out, k, {
          value: v,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } catch {
        // drop this field
      }
    }
    if (hasCause) {
      try {
        Object.defineProperty(out, "cause", {
          value: sanitisedCause,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } catch {
        // drop cause
      }
    }
    if (sanitisedErrors !== undefined) {
      try {
        Object.defineProperty(out, "errors", {
          value: sanitisedErrors,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } catch {
        // drop errors
      }
    }
    return out;
  } catch {
    // Catastrophic failure (frozen Error, malicious prototype, …).
    // Return a minimal Error so toThrowable still has something to throw.
    return new Error("An error occurred");
  }
}

/**
 * Sanitise any value. Type-routed:
 *   - primitives (number, boolean, bigint, symbol, null, undefined)
 *     → returned as-is (nothing to redact)
 *   - string  → value-pattern redaction applied
 *   - Error   → routed through `sanitizeError`
 *   - object  → deep-redact walks string keys; symbol-keyed properties are dropped
 *
 * Marks on uncertainty: if the value is so exotic the redactor can't
 * process it (hostile Proxy, throwing prototype trap), returns the
 * `"[unsanitisable]"` placeholder string instead of the original value.
 * The unsanitised value is never propagated.
 */
export function sanitize(value: unknown): unknown {
  try {
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
      return String(deepRedact.redact(value));
    }

    if (value instanceof Error) {
      return sanitizeError(value);
    }

    if (typeof value === "object") {
      const result = deepRedact.redact(value) as object;
      // Symbol-keyed properties are dropped by virtue of deep-redact only
      // walking string keys — we don't patch them back on.
      return typeof result === "object" && result !== null ? result : {};
    }

    return value;
  } catch {
    // Uncatchable shape — mark as unsanitisable.
    return UNSANITISABLE;
  }
}


// ===========================================================================
// SECTION 4 — PUBLIC THROW API
// ===========================================================================
// The convention every action function in the package follows:
//
//     try { ... } catch (e) { throw toThrowable(e); }
//
// Anything thrown by toThrowable is a real Error with
// no unredacted secrets in any reachable property.

/**
 * JSON.stringify variant that never throws on circular refs or BigInt.
 * Used by `toThrowable` to turn a sanitised plain object into a string
 * message. Circular refs become the sentinel "[CIRCULAR]" so the
 * resulting string remains structurally readable.
 */
function safeStringify(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(value, (_k, v) => {
      if (typeof v === "bigint") return `${v}n`;
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[CIRCULAR]";
        seen.add(v);
      }
      return v;
    });
    // JSON.stringify returns undefined for undefined / function / symbol inputs.
    return json ?? "";
  } catch {
    try {
      return String(value);
    } catch {
      return "";
    }
  }
}

/**
 * Take any thrown value, return a safe Error to rethrow.
 *
 *     try { ... } catch (e) { throw toThrowable(e); }
 *
 * Never throws, even on circular structures, BigInt
 * values, hostile Proxies, or other exotic shapes. If sanitisation
 * dropped the input entirely, returns `new Error("An error occurred")`
 * rather than echoing anything potentially unsafe.
 */
export function toThrowable(error: unknown): Error {
  const result = sanitize(error);
  if (result instanceof Error) return result;
  if (typeof result === "object" && result !== null) {
    return new Error(safeStringify(result) || "An error occurred");
  }
  // Primitive result (Symbol, BigInt, raw string, or undefined from a drop):
  // re-run the redactor on String(result) so secret patterns inside a Symbol
  // description, boxed-primitive contents, etc., are still caught here.
  const cleaned = String(deepRedact.redact(String(result)));
  return new Error(cleaned || "An error occurred");
}

/**
 * Escape hatch: returns `new Error(message)` directly. No sanitisation
 * is applied, so the caller MUST ensure the message is safe. The
 * default convention is `toThrowable(e)`, not this.
 */
export function genericError(message: string): Error {
  return new Error(message);
}


// ===========================================================================
// SECTION 5 — RETRY
// ===========================================================================
// Helper for external non-NEAR calls (dstack, Phala HTTP). NEAR RPC has
// its own retry inside JsonRpcProvider, so this is not used for NEAR.

/**
 * Default predicate for `withRetry`. Retries everything EXCEPT a small
 * denylist of deterministic failures (JS programmer errors, HTTP 4xx
 * other than 408/429). Anything else — network blips, 5xx, timeouts,
 * unknown — retries.
 */
export function defaultRetryable(e: unknown): boolean {
  // Node 18+ undici throws TypeError("fetch failed") on transient
  // connection errors with the underlying network error on .cause —
  // those ARE retryable. A plain TypeError with no .cause is a
  // programmer error (wrong call, bad type) and isn't worth retrying.
  if (e instanceof TypeError) {
    return (e as Error & { cause?: unknown }).cause !== undefined;
  }
  // Other JS programmer errors — retrying just re-runs the bug.
  if (
    e instanceof RangeError ||
    e instanceof ReferenceError ||
    e instanceof SyntaxError ||
    e instanceof URIError
  ) {
    return false;
  }

  // HTTP 4xx other than 408 (Request Timeout) and 429 (Too Many Requests)
  // are caller errors that won't fix themselves on retry.
  const status = (e as { status?: unknown })?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return status === 408 || status === 429;
  }

  // Everything else — network blip, 5xx, AbortError, unknown — retries.
  return true;
}

/** Options for `withRetry`. All fields optional. */
export interface RetryOpts {
  /** Total attempts. Default 3. */
  attempts?: number;
  /**
   * Sleep schedule between attempts. A single number is uniform across
   * attempts; an array is indexed by `attempts - 1` (so `[a, b]` means
   * `a` ms before attempt 2, `b` ms before attempt 3). Default
   * `[250, 500, 1000]`.
   */
  delayMs?: number | number[];
  /** Override the default retry predicate. */
  retryable?: (e: unknown) => boolean;
}

const DEFAULT_DELAYS: number[] = [250, 500, 1000];

/** Promise-based sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pick the right backoff delay for retry attempt `index`. For an array
 * schedule, clamps to the last entry once exhausted (so attempts beyond
 * the array's length all use the final delay).
 */
function getDelay(delayMs: RetryOpts["delayMs"], index: number): number {
  if (typeof delayMs === "number") return delayMs;
  const arr = delayMs ?? DEFAULT_DELAYS;
  return arr[Math.min(index, arr.length - 1)] ?? 0;
}

/**
 * Retry helper for external non-NEAR calls. Default: 3 attempts with
 * `[250, 500, 1000]` ms backoff. The last attempt's failure is rethrown
 * via `toThrowable(...)` so the escaping error is sanitised.
 *
 * Usage:
 *
 *     const key = await withRetry(() => dstackClient.getKey(path));
 *
 * For a single attempt (no retry): pass `{ retryable: () => false }`.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const retryable = opts.retryable ?? defaultRetryable;

  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const isLast = i === attempts - 1;
      if (isLast || !retryable(e)) {
        throw toThrowable(e);
      }
      await sleep(getDelay(opts.delayMs, i));
    }
  }
  // Unreachable — the loop always either returns or throws.
  throw toThrowable(lastError);
}


// ===========================================================================
// SECTION 6 — SAFE KEY PARSING
// ===========================================================================
// Safe wrappers around the @near-js secret-key parsers. The input to
// each of these IS the secret being parsed, so on any parse failure we
// throw a generic error — the original error's message (which can
// echo a character of the secret via the underlying @scure/base
// decoder) and its stack frames never escape.
//
// Use these in place of `KeyPair.fromString(secret)` and
// `KeyPairSigner.fromSecretKey(secret)` anywhere a secret-key string
// is parsed.

/**
 * Parse a NEAR secret-key string into a KeyPair. On parse failure
 * throws `genericError("Failed to parse key")` — no echo of the
 * original error or the input.
 */
export function safeParseKeyPair(secret: string): KeyPair {
  try {
    return KeyPair.fromString(secret as KeyPairString);
  } catch {
    throw genericError("Failed to parse key");
  }
}

/**
 * Parse a NEAR secret-key string into a KeyPairSigner. On parse failure
 * throws `genericError("Failed to parse key")` — no echo of the
 * original error or the input.
 */
export function safeParseSigner(secret: string): KeyPairSigner {
  try {
    return KeyPairSigner.fromSecretKey(secret as KeyPairString);
  } catch {
    throw genericError("Failed to parse key");
  }
}