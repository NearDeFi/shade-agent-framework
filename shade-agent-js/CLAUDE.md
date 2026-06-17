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

## Secret-key parsing

Never call `KeyPair.fromString()` or `KeyPairSigner.fromSecretKey()`
directly — a parse failure from `@near-js` echoes the secret-key string
in its message. Use the wrappers `safeParseKeyPair(secret)` /
`safeParseSigner(secret)` (in `utils/errors.ts`), which catch the parse
error and rethrow `genericError("Failed to parse key")` with no secret
material. Same fail-closed principle as `toThrowable`/`sanitize`: a
secret must never reach a throw or log surface.

## Public API surface

`src/index.ts` is the entire public API: `ShadeClient`; the types
`ShadeConfig`, `Measurements`, `FullMeasurements`,
`DstackAttestationForContract`; and the error utilities `sanitize`,
`toThrowable`, `addSensitive`. Everything else — `withRetry`,
`genericError`, `safeParse*`, the dstack/Phala/NEAR helpers — is
internal. Adding, renaming, or removing an export is a public-API change:
update `docs/reference/api.md` (and check `shade-agent-template`) per the
repo-wide rules.

## Contract call boundary

Client-side code is camelCase (`agentAccountId`, `dstackClient`); the NEAR
contract interface is snake_case (`register_agent`, `account_id`,
`requires_tee`, `{ quote, collateral, tcb_info }`). Args passed into a
contract call must use the contract's snake_case names — there is no
auto-conversion at the boundary.