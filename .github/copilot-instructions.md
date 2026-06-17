# Copilot code review instructions for shade-agent-framework

The Shade Agent Framework monorepo: verifiable, trust-minimized Web3 agents that sign
cross-chain transactions, with trust rooted in TEE (Phala/dstack) attestations verified inside
NEAR smart contracts. Mixed Rust + TypeScript/JavaScript — `shade-attestation` (Rust crate
verifying attestations in NEAR contracts) and `shade-contract-template` (Rust NEAR contract);
`shade-agent-js` (published TS library), `shade-agent-cli` (published deploy CLI parsing
`deployment.yaml`), `shade-agent-template` (example agent), and `tests-in-tee` (end-to-end
suite). Apply the checks appropriate to the language of each changed file.

## What to review

Review the changed lines and their direct impact. Check for:

- **Security & safety:** TEE attestation verification (quote/measurement validation,
  compose-hash, PPID, approved-measurement gating) never weakened or bypassed; contract
  owner-gating preserved (no unauthenticated path to approve measurements, register an agent,
  or sign); only authorized payloads can be chain-signed; no private/signing keys, NEAR keys,
  or API keys (PHALA_API_KEY, TESTNET/SPONSOR) in code, logs, tests, or fixtures; untrusted
  input validated (attestation quotes, RPC responses, `deployment.yaml`).
- **Architecture & patterns:** cross-package sync (a change to a package updates its
  `docs/reference`, the example templates, and `tests-in-tee/`); published-API discipline
  (breaking changes to shade-agent-js exports, the CLI `deployment.yaml` schema, contract
  methods, or the shade-attestation crate need version/consumer/doc updates);
  `example-deployment-files/` stay valid against the parser; (Rust) no `unwrap`/`panic!` on
  attacker-influenced input.
- **Bugs:** logic errors, off-by-one mistakes, missing error handling,
  incorrect return values, division by zero, unhandled edge cases.
- **Performance & production:** on-chain gas/compute and no unbounded loops or storage growth
  in contracts; error handling and retries on RPC/Phala/deploy calls; sensible timeouts and no
  blocking ops in the deploy pipeline.

## Rules

- Only flag issues you are confident are real and introduced by this PR. Skip
  likely false positives, nitpicks, and pre-existing issues the change doesn't touch.
- Skip anything a linter or compiler already catches — CI enforces formatting and lint.
- For each issue, say why it matters and suggest a concrete fix.
- Comment only on what the diff affects; do not review unchanged code.
