**Most important concerns specific to this project**

- **TEE attestation is the trust root.** Any change to quote/measurement verification, compose-hash computation, PPID handling, or approved-measurement gating (in `shade-attestation` and `shade-contract-template`) must preserve — never weaken or short-circuit — the guarantee that only genuinely attested TEEs are trusted. Treat any change to `shade-attestation` as a breaking change to the contract.
- **Contract access control & signing guardrails.** Owner-gated contract methods stay owner-gated, and the chain-signature path must only ever sign authorized, intended payloads. Never introduce an unauthenticated path to approve measurements, register an agent, or request a signature.
- **Never expose key material or credentials.** Private/signing/derivation keys, NEAR account keys, and API keys (`PHALA_API_KEY`, testnet/sponsor keys) must never appear in code, logs, tests, fixtures, or error messages — use environment variables (see the `tests-in-tee` env setup).
- **Keep docs, consumers, and tests in lockstep (root CLAUDE.md).** A change to any package is not done until the matching `docs/reference/*` (`api.md`, `cli.md`, `agent-contract.md`), the example templates (`shade-agent-template`), the CLI examples (`shade-agent-cli/example-deployment-files/`), and the `tests-in-tee/` scenarios it affects have all been updated to match.
- **Published packages have public-API contracts.** `@neardefi/shade-agent-js`, `@neardefi/shade-agent-cli`, and the `shade-attestation` crate are published — treat changes to exports, function signatures, the CLI `deployment.yaml` schema/validation, or contract method signatures as breaking, and update versions, consumers, and docs together.
- **Respect the `file:` local-dependency build order.** `shade-agent-template` and `tests-in-tee` consume `shade-agent-js` via `file:../shade-agent-js`; rebuild the library (`npm run build`) before building or typechecking them.
- **End-to-end correctness only proves out under attestation.** Changes to agent registration, compose-hash/PPID/measurement approval, key derivation/rotation, or the CLI deploy pipeline must be exercised by `tests-in-tee/` — but that suite needs live testnet + Phala credentials, so flag it for a maintainer to run rather than running it in the PR gate.

---

## Universal rules 

These apply to all work in this repository, on top of the project-specific concerns above:

- **Good test coverage, always.** Every code path added or changed gets unit tests covering the happy path, edge cases, all flows through the change, and malicious or hostile inputs.
- **Regression tests for every bug fix.** Reproduce the bug in a test that fails on the old code; the fix turns it green; the test stays in the suite forever.
- **Never commit secrets.** No keys, tokens, credentials, or customer data in code, config, tests, fixtures, or logs — use environment variables or secret stores.
- **Justify new dependencies.** Prefer the standard library or dependencies already in the repo; adding a new one requires a stated reason (capability, size, maintenance, security surface) in the PR.
