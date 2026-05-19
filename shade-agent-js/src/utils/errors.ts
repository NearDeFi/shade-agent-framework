/**
 * Error / sanitisation utilities. The single trust boundary for secret leak
 * prevention in shade-agent-js: every catch in the package should rethrow
 * via `toThrowable(e)` so that sensitive fields and recognised secret value
 * patterns are redacted before the error escapes.
 */

import { DeepRedact } from "@hackylabs/deep-redact/index.ts";

const REDACTED = "[REDACTED]";

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
];

interface StringTest {
  pattern: RegExp;
  replacer: (value: string, pattern: RegExp) => string;
}

// IMPORTANT: patterns must NOT use the /g flag. Deep-redact calls
// `pattern.test(value)` on each pattern (utils/index.js:244); /g makes
// `.test` stateful via `lastIndex`, so consecutive calls alternate
// match/miss. For surgical (substring) replacers, construct a global
// regex inline at replace time.
const SHADE_REDACT_PATTERNS: StringTest[] = [
  // Whole-string redaction on any string containing a sensitive keyword.
  {
    pattern:
      /privateKey|private_key|secretKey|secret_key|extendedSecretKey|agentPrivateKeys?/i,
    replacer: () => REDACTED,
  },
  // NEAR canonical secret-key string form.
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
  // BIP32 extended private keys: xprv (BIP32 mainnet), tprv (testnet),
  // yprv (BIP49), zprv (BIP84), vprv (BIP86), and their uppercase
  // multisig variants.
  {
    pattern: /\b[xytzuvXYZTUV]prv[1-9A-HJ-NP-Za-km-z]{50,108}\b/,
    replacer: () => REDACTED,
  },
  // Bitcoin WIF (`5`/`K`/`L` + base58, 51-52 chars).
  {
    pattern: /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/,
    replacer: () => REDACTED,
  },
];

// Mutable lists; rebuilt-on-extend via `addSensitive`.
let activeKeys: string[] = [...SHADE_REDACT_KEYS];
let activePatterns: StringTest[] = [...SHADE_REDACT_PATTERNS];
let deepRedact = build(activeKeys, activePatterns);

function build(keys: string[], patterns: StringTest[]) {
  return new DeepRedact({
    serialise: false,
    blacklistedKeys: keys,
    stringTests: patterns,
    // Redact any value type (string, object, array) under a blacklisted key,
    // not just strings. Otherwise a field like `signer: { key: { ... } }` would
    // be walked into instead of wholesale-replaced, leaving the leaf value
    // dependent on a separate field-name or regex hit deeper in.
    types: ["string", "object"],
  });
}

/**
 * Extend the redact configuration at runtime. Subsequent calls to `sanitize`
 * / `toThrowable` will also redact the new field names and apply the new
 * value-regex patterns. Lets consumers cover additional secret forms without
 * forking the library.
 */
export function addSensitive(opts: {
  keys?: string[];
  patterns?: StringTest[];
}): void {
  if (opts.keys?.length) activeKeys = [...activeKeys, ...opts.keys];
  if (opts.patterns?.length) activePatterns = [...activePatterns, ...opts.patterns];
  deepRedact = build(activeKeys, activePatterns);
}

/**
 * Sanitizes any value: strings, objects, Errors, and primitives.
 * Redacts sensitive keys (privateKey, secretKey, signer, mnemonic, …) by
 * field name; redacts recognised secret string patterns (`ed25519:…`,
 * `secp256k1:…`, PEM, BIP32 extended, Bitcoin WIF) by value.
 *
 * - string         → sanitized string
 * - Error          → new Error preserving all (sanitized) fields; `stack` dropped
 * - object/array   → redacted copy (deep)
 * - other          → returned as-is
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
    return String(deepRedact.redact(value));
  }

  if (value instanceof Error) {
    return sanitizeError(value);
  }

  if (typeof value === "object") {
    const result = deepRedact.redact(value) as object;
    return typeof result === "object" && result !== null ? result : {};
  }

  return value;
}

/**
 * Sanitise an Error into a new Error that:
 * - has the (sanitised) message
 * - preserves every own property (name, type, code, status, cause, custom…)
 *   except `stack`, in their recursively-sanitised form
 * - is still an `Error` instance
 */
function sanitizeError(error: Error): Error {
  // Pre-extract and recursively sanitise nested Errors so they don't get
  // mangled by deep-redact's standard Error transformer (which would turn
  // an Error instance into a plain `{ _transformer: "error", ... }` object).
  // Error.message is also non-enumerable so a naive object-walk would miss
  // it; sanitizeError extracts message explicitly into the plain bag below.
  const sanitiseInner = (v: unknown): unknown => {
    if (v instanceof Error) return sanitizeError(v);
    if (typeof v === "object" && v !== null) return sanitize(v);
    return v;
  };
  let sanitisedCause: unknown;
  let hasCause = false;
  if ("cause" in error) {
    hasCause = true;
    sanitisedCause = sanitiseInner(
      (error as Error & { cause?: unknown }).cause,
    );
  }
  let sanitisedErrors: unknown;
  if (error instanceof AggregateError) {
    sanitisedErrors = error.errors.map(sanitiseInner);
  }

  // Build a plain-object view of the Error's other own properties, excluding
  // anything we handle out-of-band (cause/errors above, stack always).
  const own: Record<string, unknown> = {
    name: error.name,
    message: error.message ?? "",
  };
  for (const k of Object.getOwnPropertyNames(error)) {
    if (k === "stack" || k === "cause" || k === "errors") continue;
    if (k in own) continue;
    own[k] = (error as unknown as Record<string, unknown>)[k];
  }

  const sanitised = deepRedact.redact(own) as Record<string, unknown>;
  const msg = String(sanitised.message ?? "");
  const out = new Error(msg || "An error occurred");

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
      // Some property names may be non-writable on Error; skip silently.
    }
  }

  // Attach the already-sanitised nested Error(s) AFTER deep-redact so they
  // remain Error instances rather than being converted to plain objects.
  if (hasCause) {
    Object.defineProperty(out, "cause", {
      value: sanitisedCause,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  if (sanitisedErrors !== undefined) {
    Object.defineProperty(out, "errors", {
      value: sanitisedErrors,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * Returns an Error suitable for throwing: passes the input through `sanitize`,
 * then ensures the result is a real `Error` instance. The single error
 * convention in shade-agent-js is:
 *
 *     try { ... } catch (e) { throw toThrowable(e); }
 */
export function toThrowable(error: unknown): Error {
  const result = sanitize(error);
  if (result instanceof Error) return result;
  if (typeof result === "object" && result !== null) {
    return new Error(JSON.stringify(result));
  }
  return new Error(String(result) || "An error occurred");
}

/**
 * Returns `new Error(message)` directly — no input sanitisation, no field
 * preservation. Opt-in escape hatch for cases where echoing the input is
 * genuinely undesirable. The default convention is `throw toThrowable(e)`.
 */
export function genericError(message: string): Error {
  return new Error(message);
}

/**
 * NEAR `TypedError.type` values that are deterministic — retrying them is
 * wasted latency. The transport-layer retry inside `JsonRpcProvider` already
 * handles transient RPC blips; `withRetry` is for non-NEAR external calls
 * (dstack, Phala collateral fetch). This list is what we *exclude* from the
 * default retry behaviour.
 */
const NON_RETRYABLE_TYPED_ERRORS: ReadonlySet<string> = new Set([
  "AccountDoesNotExist",
  "InvalidAccessKey",
  "InvalidSignature",
  "NotEnoughBalance",
  "MethodNotFound",
  "TooLargeContractState",
]);

/**
 * Default predicate for `withRetry`. Retries everything **except** a small
 * denylist of deterministic failures (JS programmer errors, HTTP 4xx other
 * than 408/429, deterministic NEAR TypedErrors). Network blips, 5xx, timeouts,
 * unknown errors all retry.
 */
export function defaultRetryable(e: unknown): boolean {
  // Node 18+ undici throws TypeError("fetch failed") on transient connection
  // errors with the underlying network error on .cause — those ARE retryable.
  // Plain TypeErrors with no cause are programmer errors and stay non-retryable.
  if (e instanceof TypeError) {
    return (e as Error & { cause?: unknown }).cause !== undefined;
  }
  // Other JS programmer errors — retrying re-runs the bug.
  if (
    e instanceof RangeError ||
    e instanceof ReferenceError ||
    e instanceof SyntaxError ||
    e instanceof URIError
  ) {
    return false;
  }

  // HTTP 4xx except 408 (Request Timeout) and 429 (Too Many Requests).
  const status = (e as { status?: unknown })?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return status === 408 || status === 429;
  }

  // NEAR TypedError deterministic types.
  const type = (e as { type?: unknown })?.type;
  if (typeof type === "string" && NON_RETRYABLE_TYPED_ERRORS.has(type)) {
    return false;
  }

  // Network blip, 5xx, AbortError, unknown → retry.
  return true;
}

export interface RetryOpts {
  /** Total attempts. Default 3. */
  attempts?: number;
  /**
   * Sleep schedule between attempts. A single number is uniform; an array is
   * indexed by `attempts - 1` (so [a, b] means a before attempt 2, b before
   * attempt 3). Default [250, 500, 1000].
   */
  delayMs?: number | number[];
  /** Override the default retry predicate. */
  retryable?: (e: unknown) => boolean;
  /** External cancellation. */
  signal?: AbortSignal;
}

const DEFAULT_DELAYS: number[] = [250, 500, 1000];

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function getDelay(delayMs: RetryOpts["delayMs"], index: number): number {
  if (typeof delayMs === "number") return delayMs;
  const arr = delayMs ?? DEFAULT_DELAYS;
  return arr[Math.min(index, arr.length - 1)] ?? 0;
}

/**
 * Retry helper for external non-NEAR calls (dstack, Phala HTTP). Default 3
 * attempts with [250, 500, 1000] ms backoff. On final attempt, rethrows the
 * last error via `toThrowable(...)` so the message is sanitised. Aborts
 * promptly on `signal.aborted`.
 *
 *     const x = await withRetry(() => dstackClient.getKey(path));
 *
 * For "try once, no retry" semantics: `withRetry(fn, { retryable: () => false })`.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const retryable = opts.retryable ?? defaultRetryable;
  const signal = opts.signal;

  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const isLast = i === attempts - 1;
      if (isLast || !retryable(e)) {
        throw toThrowable(e);
      }
      await sleep(getDelay(opts.delayMs, i), signal);
    }
  }
  // Unreachable — the loop always either returns or throws.
  throw toThrowable(lastError);
}
