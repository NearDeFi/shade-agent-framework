# shade-agent-js — Claude guidance

## Error-handling convention

Every function performing an action (RPC, HTTP, signer, fs, dstack) MUST
wrap its body in try/catch and end the catch with:

    throw toThrowable(e);

That's the uniform rule. `toThrowable` runs the input through `sanitize`
(recursively redacting any sensitive field name or recognised secret
value pattern) and rethrows a clean `Error` carrying every other
sanitised field — `type`, `code`, `status`, `name`, `cause`, custom
fields — so callers can dispatch on shape (e.g.
`err.type === "AccountDoesNotExist"`).

`genericError(msg)` is an opt-in escape hatch for cases where echoing
the input is genuinely undesirable. Don't use it as a default.

## Retries

- **No retries on NEAR RPC** — `JsonRpcProvider` already retries 3× with
  2 s backoff at the transport layer.
- **External non-NEAR calls** (Phala collateral fetch, dstack
  `info`/`getQuote`/`getKey`) use `withRetry(fn, { attempts: 3 })`
  with default backoff `[250, 500, 1000]` ms.
- `withRetry`'s default `retryable` predicate is "retry everything
  except a denylist": JS programmer errors (`TypeError`, `RangeError`,
  …), HTTP 4xx except 408/429, and deterministic NEAR TypedErrors
  (`AccountDoesNotExist`, `InvalidAccessKey`, `InvalidSignature`,
  `NotEnoughBalance`, `MethodNotFound`, `TooLargeContractState`). Pass
  `{ retryable }` per call to override.

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
