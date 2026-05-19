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

// Strip stateful flags (`g`, `y`) from a regex. Deep-redact uses
// `pattern.test(value)` which is stateful on `/g`/`/y` regexes via
// `lastIndex`, causing alternating match/miss across calls. We keep
// the original pattern accessible to the replacer (so consumers'
// `v.replace(p, X)` replace-all semantics still work).
function stripStatefulFlags(re: RegExp): RegExp {
  if (!/[gy]/.test(re.flags)) return re;
  return new RegExp(re.source, re.flags.replace(/[gy]/g, ""));
}

/**
 * Extend the redact configuration at runtime. Subsequent calls to `sanitize`
 * / `toThrowable` will also redact the new field names and apply the new
 * value-regex patterns. Lets consumers cover additional secret forms without
 * forking the library.
 *
 * Caller-provided regexes with `g`/`y` flags are sanitised: a non-stateful
 * clone is used for the internal `.test()` call, but the original pattern
 * is passed through to the replacer so any consumer relying on `/g` for
 * replace-all in their own replacer keeps working.
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
      // If no flags were stripped, original === stripped — reuse directly.
      if (stripped === original) return p;
      return {
        pattern: stripped,
        replacer: (v) => p.replacer(v, original),
      };
    });
    activePatterns = [...activePatterns, ...safe];
  }
  deepRedact = build(activeKeys, activePatterns);
}

/**
 * Sanitizes any value: strings, objects, Errors, and primitives.
 * Redacts sensitive keys (privateKey, secretKey, signer, mnemonic, …) by
 * field name; redacts recognised secret string patterns (`ed25519:…`,
 * `secp256k1:…`, PEM, BIP32 extended, Bitcoin WIF) by value.
 *
 * - string         → sanitized string
 * - Error          → new Error preserving all (sanitized) fields, including stack
 * - object/array   → redacted copy (deep); symbol-keyed properties also walked
 * - other          → returned as-is
 *
 * Total: never throws — falls back to a safe `[unsanitisable]` placeholder
 * if anything inside crashes (hostile Proxy, throwing getter, etc.).
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
      const out =
        typeof result === "object" && result !== null ? result : {};
      // Deep-redact walks string keys only. Patch sanitised symbol-keyed
      // properties onto the clone so leaks via `{[Symbol("t")]: secret}`
      // don't escape via `console.log` / `util.inspect`.
      try {
        attachSymbolKeys(out, value, new WeakSet<object>());
      } catch {
        // Best effort — never let symbol-walk failures crash sanitise.
      }
      return out;
    }

    return value;
  } catch {
    return "[unsanitisable]";
  }
}

/**
 * Walk symbol-keyed properties of `original` (recursively) and copy
 * sanitised versions onto the parallel structure in `clone`. Both
 * objects are expected to mirror each other in string-key shape (which
 * holds when `clone` is deep-redact's return value).
 */
function attachSymbolKeys(
  clone: object,
  original: object,
  seen: WeakSet<object>,
): void {
  if (seen.has(original)) return;
  seen.add(original);
  for (const sym of Object.getOwnPropertySymbols(original)) {
    try {
      const v = (original as Record<symbol, unknown>)[sym];
      (clone as Record<symbol, unknown>)[sym] = sanitize(v);
    } catch {
      // Hostile getter — skip this key.
    }
  }
  // Recurse where both sides have a nested object at the same string key.
  for (const k of Object.keys(clone)) {
    let cloneVal: unknown;
    let origVal: unknown;
    try {
      cloneVal = (clone as Record<string, unknown>)[k];
      origVal = (original as Record<string, unknown>)[k];
    } catch {
      continue;
    }
    if (
      typeof cloneVal === "object" &&
      cloneVal !== null &&
      typeof origVal === "object" &&
      origVal !== null
    ) {
      attachSymbolKeys(cloneVal, origVal, seen);
    }
  }
}

/**
 * Sanitise an Error into a new Error that:
 * - has the (sanitised) message
 * - preserves every own property (name, type, code, status, cause, custom…)
 *   except `stack`, in their recursively-sanitised form
 * - is still an `Error` instance
 */
// Safely read a property — getter side-effects or throwing Proxy traps
// can't crash the sanitiser.
function safeRead(obj: object, k: PropertyKey): unknown {
  try {
    return (obj as Record<PropertyKey, unknown>)[k];
  } catch {
    return undefined;
  }
}

function sanitizeError(error: Error): Error {
  try {
    // Pre-extract and recursively sanitise nested Errors so they don't get
    // mangled by deep-redact's standard Error transformer (which would turn
    // an Error instance into a plain `{ _transformer: "error", ... }` object).
    // Error.message is also non-enumerable so a naive object-walk would miss
    // it; sanitizeError extracts message explicitly into the plain bag below.
    // Error.cause and AggregateError.errors are typed as `unknown` — they can
    // hold any value, including primitive strings carrying secrets. Routing
    // everything through `sanitize` redacts strings (regex), objects
    // (deep-redact), and Errors (sanitizeError), while leaving safe primitives
    // (numbers, booleans, BigInt, symbols, null/undefined) untouched.
    let sanitisedCause: unknown;
    let hasCause = false;
    if ("cause" in error) {
      hasCause = true;
      sanitisedCause = sanitize(safeRead(error, "cause"));
    }
    let sanitisedErrors: unknown;
    if (error instanceof AggregateError) {
      const arr = safeRead(error, "errors");
      if (Array.isArray(arr)) {
        sanitisedErrors = arr.map((e) => sanitize(e));
      }
    }

    // Build a plain-object view of the Error's other own properties.
    // `Reflect.ownKeys` returns BOTH string and symbol keys; symbol keys
    // are walked so a `{[Symbol("token")]: "ed25519:secret"}` attached
    // to an error can't leak via console.log / util.inspect.
    // `stack` is passed through sanitise like any other field — useful for
    // debugging deployed agents, and the regex still catches secret patterns
    // that might happen to appear in a stack frame.
    const own: Record<string, unknown> = {
      name: error.name,
      message: error.message ?? "",
    };
    const symbolEntries: { key: symbol; value: unknown }[] = [];
    for (const k of Reflect.ownKeys(error)) {
      if (k === "cause" || k === "errors") continue;
      if (typeof k === "string" && k in own) continue;
      const v = safeRead(error, k);
      if (typeof k === "symbol") {
        symbolEntries.push({ key: k, value: sanitize(v) });
      } else {
        own[k] = v;
      }
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

    // Re-attach the sanitised symbol-keyed properties.
    for (const { key, value } of symbolEntries) {
      try {
        Object.defineProperty(out, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } catch {
        // Skip silently — best effort.
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
  } catch {
    // Ultimate safety net: if any step crashes (hostile Proxy, deep-redact
    // bug, frozen Error, etc.), return a generic Error rather than letting
    // the exception escape from toThrowable.
    return new Error("An error occurred");
  }
}

// Serialise any value to a string without throwing — handles circular
// references and BigInt values that would crash `JSON.stringify`. The
// whole point of toThrowable is to be safe inside any catch block, so it
// must not itself throw on exotic input shapes.
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
    // JSON.stringify returns undefined for `undefined`, functions, and symbols.
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
 * Returns an Error suitable for throwing: passes the input through `sanitize`,
 * then ensures the result is a real `Error` instance. The single error
 * convention in shade-agent-js is:
 *
 *     try { ... } catch (e) { throw toThrowable(e); }
 *
 * Guaranteed total — never throws, even on circular structures, BigInt
 * values, or other non-JSON-serialisable inputs.
 */
export function toThrowable(error: unknown): Error {
  const result = sanitize(error);
  if (result instanceof Error) return result;
  if (typeof result === "object" && result !== null) {
    // Object already went through deep-redact recursively in sanitize —
    // the stringified form is safe to use directly. Running it through
    // the regex sweep again would false-positive on JSON key names like
    // `"privateKey":` that legitimately appear in a sanitised payload.
    return new Error(safeStringify(result) || "An error occurred");
  }
  // For primitive inputs (Symbol, BigInt, raw string, boxed wrappers that
  // sanitize couldn't introspect) re-sanitise the String() form so secret
  // patterns inside a Symbol description, etc., are still redacted at the
  // final boundary.
  const cleaned = String(deepRedact.redact(String(result)));
  return new Error(cleaned || "An error occurred");
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
