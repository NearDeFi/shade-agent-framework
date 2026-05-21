# shade-agent-js — Claude guidance

## Error-handling convention

Every throw site uses one of two functions; **bare `throw new Error(...)`
is forbidden** in `src/`. The two patterns:

**`throw toThrowable(e)`** — in catch handlers, when the input is an
unknown thrown value:

    try { ... } catch (e) { throw toThrowable(e); }

`toThrowable` runs the input through `sanitize` (recursively redacting
any sensitive field name or recognised secret value pattern) and rethrows
a clean `Error` carrying every other sanitised field — `type`, `code`,
`status`, `name`, `cause`, custom fields — so callers can dispatch on
shape (e.g. `err.type === "AccountDoesNotExist"`).

**`throw genericError("constant message")`** — for known-safe constant
messages where there is no input to sanitise: pre-condition guards,
validation errors, internal control-flow signals, etc.:

    if (!this.config.agentContractId) {
      throw genericError("agentContractId is required for ...");
    }

`genericError` is `new Error(message)` with no sanitisation. The caller
is asserting that the message is a constant string they wrote, with no
interpolated input from secret material. Don't pass dynamic content
through `genericError` unless you can prove it's safe.

## Retries

- **No retries on NEAR RPC** — `JsonRpcProvider` already retries 3× with
  2 s backoff at the transport layer.
- **External non-NEAR calls** (Phala collateral fetch, dstack
  `info`/`getQuote`/`getKey`) use `withRetry(fn, { attempts: 3 })`
  with default backoff `[250, 500, 1000]` ms.
- `withRetry`'s default `retryable` predicate is "retry everything
  except a denylist": JS programmer errors (`TypeError`, `RangeError`,
  …) and HTTP 4xx except 408/429. Pass `{ retryable }` per call to
  override. `withRetry` is only used for non-NEAR external calls
  (dstack, Phala HTTP) — NEAR RPC has its own retry inside
  `JsonRpcProvider`, so we deliberately don't try to recognise NEAR-
  specific deterministic error types here.

When throwing a non-OK HTTP response that should be retryable, attach
the status on the error so the predicate can match cleanly:

    throw Object.assign(new Error("Failed to fetch X"), { status: response.status });

## Sanitisation

`sanitize` / `toThrowable` redact:

**By field name** (whole value replaced with `[REDACTED]`):

`privateKey`, `private_key`, `secretKey`, `secret_key`,
`extendedSecretKey`, `signer`, `key`, `keyPair`, `agentPrivateKey`,
`agentPrivateKeys`, `mnemonic`, `mnemonicPhrase`, `seedPhrase`,
`seed_phrase`, `seed`, `signingKey`, `signing_key`, `_signingKey`,
`_privateKey`, `xprv`, `xpriv`, `masterKey`, `master_key`, `keystore`.

**By value pattern** (see `SHADE_REDACT_PATTERNS` in `src/utils/errors.ts`
for the authoritative source):

- Any string containing `privateKey` / `private_key` / `secretKey` /
  `secret_key` / `extendedSecretKey` / `agentPrivateKey(s)` (case-insensitive)
  — whole string redacted (aggressive; intentional)
- `ed25519:…` / `secp256k1:…` — surgical substring redaction
- PEM private key blocks (`-----BEGIN … PRIVATE KEY----- … -----END … -----`)
  — whole block redacted
- BIP32 extended private keys (xprv / yprv / zprv / tprv / uprv / vprv and
  uppercase variants) — whole match redacted
- Bitcoin WIF (`5` / `K` / `L` prefix + 50–51 base58 chars) — whole match redacted

Note: patterns are stored without `/g` flag — deep-redact uses
`RegExp.test()` which is stateful on global regexes (causes alternating
match/miss). Surgical replacers construct a fresh global regex inline.

Extend at runtime via `addSensitive({ keys?, patterns? })`. Caller-provided
patterns have `/g` / `/y` flags stripped from the internal `.test()`
clone but the original pattern is passed through to the replacer, so
`v.replace(p, X)`-style replace-all in your own replacer still works.
Mutation is process-global; call it once at boot.

Never include a raw `KeyPair`/`KeyPairSigner`/`Account`/mnemonic in a
thrown error via template literal — pass the error through
`toThrowable` so the sanitiser walks it. If you must hand a value
through, name the carrying field with a redact-list name (`signer`,
`extendedSecretKey`, …) so the deep walk catches it.

## Sanitiser coverage

`sanitize` and `toThrowable` walk:

- Own **string-keyed** properties (enumerable + non-enumerable), recursively.
- **Symbol-keyed properties are dropped entirely** (not sanitised, not
  preserved). The dependency-tree audit found no library that uses
  symbol keys on errors, so dropping is fail-closed by construction.
  Locked in by `tests/unit/errors.test.ts` "symbol-keyed properties
  are dropped".
- `Error.message` (non-enumerable, extracted explicitly).
- `Error.cause` and `AggregateError.errors` — recursively, including
  primitive (string) values that might carry a secret.
- `Error.stack` — preserved and sanitised so debugging stays feasible.

Hostile inputs are isolated: throwing getters, throwing Proxy traps, and
otherwise-uncatchable failures fall through to a generic
`new Error("An error occurred")` so `toThrowable` itself never throws.

### Known gaps (documented; not plugged)

- **`Buffer` / `Uint8Array` holding raw binary secrets.** Bytes aren't
  strings — no regex applies. Only caught when the buffer sits under a
  blacklisted field name (`secretKey`, `extendedSecretKey`, …). The
  canonical NEAR / dstack paths don't attach raw bytes to errors.
- **Function values with attached own properties.** `sanitize(fn)`
  returns the function unchanged; attached `fn.secret = "…"` survives.
  No code path in the package does this.
- **Private (`#`) class fields.** Inaccessible to JS reflection by
  design — safe by virtue of unreflectability.
- **BigInt holding hex-encoded secret bits.** No string-shape match
  applies; only field-name match catches it.

## Test invariants

Two test files gate the contract:

- `tests/unit/errors.test.ts` — verifies `sanitize` / `toThrowable` /
  `genericError` / `addSensitive` themselves.
- `tests/unit/redaction.test.ts` — per-call-site fuzz: injects each
  leak shape (NEAR, PEM, BIP32, WIF, raw, mnemonic, in-cause,
  custom-property) into every wrapped function's dependency and asserts
  no marker substring escapes. This is the single load-bearing check
  that the refactor is sound; if it fails, either extend the redact
  list or fix the call site so it goes through `toThrowable`.
