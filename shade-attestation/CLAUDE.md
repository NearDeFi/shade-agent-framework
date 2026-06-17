# shade-attestation — Claude guidance

A published Rust crate that verifies Shade Agent TEE attestations. It is
compiled **into a NEAR smart contract's WASM** (consumed by
`shade-contract-template`), so the constraints below are not stylistic —
they are what makes the crate safe to run on-chain.

## `no_std`, and randomness is deliberately unsupported

`src/lib.rs` is `#![no_std]` with `extern crate alloc`. On `wasm32` a
custom `getrandom` handler returns `Error::UNSUPPORTED`: `dcap-qvl` pulls
in `getrandom`, but the NEAR VM has no RNG and randomness in a contract
is unsafe. Verification is fully deterministic. Don't add code paths that
need `std` or randomness, and don't remove the custom handler — it's the
guard that turns "accidentally called RNG" into a build/runtime error
instead of nondeterminism.

## Errors are `Result`, never panics

`DstackAttestation::verify(...) -> Result<AcceptedDstackAttestation,
VerificationError>` is a sequence of independent `?`-propagated checks
(`verify_tcb_status`, `verify_report_data`, `verify_ppid`, `verify_rtmr3`,
`verify_app_compose`, `verify_any_measurements`) — **all** must pass.
Surface failures as a `VerificationError` variant; never `panic!` or
`unwrap()`/`expect()` in library code (panics appear only in tests). The
consuming contract decides how to react to a failed verification — don't
abort the VM for it.

## Borsh + serde are both part of the public surface

The measurement/PPID types (`src/measurements.rs`, `HexBytes<N>`) derive
both serde (JSON, for the JS/CLI side) and Borsh (deterministic
serialization, for on-chain storage and contract args). Changing a
field's name, order, type, or size is a serialization break on both
sides — treat it as a breaking change.

## Cross-package

Per the repo-wide rules, any API or semantic change here is a **breaking
change to `shade-contract-template`**: verify the contract still builds,
that approved-measurements / PPID gating semantics are preserved, and run
the `tests-in-tee/` registration scenarios end-to-end.
