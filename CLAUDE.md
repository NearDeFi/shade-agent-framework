# shade-agent-framework — Claude guidance (repo-wide)

Subdirectory `CLAUDE.md` files (e.g. `shade-agent-cli/CLAUDE.md`) carry per-package conventions. The rules below apply across the whole repo.

## Installing dependencies

Default to `npm ci` for every install — it installs strictly from the committed `package-lock.json`, so local dev, CI, and Docker all reproduce the same tree. Only reach for `npm i <package>` when **adding or changing that specific dependency**, and commit the updated `package-lock.json` in the same change. Never run a bare `npm i` / `npm install` to bulk-install deps — it can silently drift the lockfile; use `npm ci`. (Installing a published package into another project — e.g. `npm i @neardefi/shade-agent-js`, `npm i -g @neardefi/shade-agent-cli` — is the same `npm i <package>` form and is expected.)

## Always update the relevant docs and consumers when changing a package

Changes to a package are not done until every downstream artefact has been updated to match. Before declaring a change complete, walk the list below.

### When changing `shade-agent-js`

- Update **`docs/reference/api.md`** — the public API reference for shade-agent-js. Any new/renamed/removed export, changed signature, changed default, or changed runtime behaviour must be reflected here.
- Update **`shade-agent-template`** if the change affects how a template consumer uses the library (imports, init args, env vars, etc.).
- Update tests in `shade-agent-js/tests/` and any **`tests-in-tee/`** scenarios that exercise the changed surface.

### When changing `shade-agent-cli`

- Update **`docs/reference/cli.md`** — the CLI / `deployment.yaml` reference. Any new/removed/renamed deployment.yaml field, new validation rule, removed default, new flag, or new error condition must be reflected here.
- Update **`shade-agent-cli/example-deployment-files/`** — every active example must remain valid against the current parser. If you add a required field, every example needs it.
- Update tests covering the CLI behaviour (including **`tests-in-tee/`** if a deploy-time invariant changed).

### When changing `shade-contract-template`

- Update **`docs/reference/agent-contract.md`** if any public method signature, owner-gated method, attestation behaviour, or storage layout changed.
- Update **`shade-agent-template`** if a contract API change affects how the template agent calls the contract.
- Update **`shade-agent-cli`** if a contract change affects how the CLI deploys / approves measurements / approves PPIDs (e.g. method names, init args, expected return types).
- Update contract tests under `shade-contract-template/tests/` and **`tests-in-tee/`** scenarios that drive the contract end-to-end.

### When changing `shade-attestation`

- Treat it as a breaking change to `shade-contract-template` — verify the contract still builds and that approved-measurements / PPID gating semantics are preserved.
- Run the **`tests-in-tee/`** scenarios that exercise registration end-to-end.

## Tests

`tests-in-tee/` is the integration-test suite that proves an end-to-end change actually works under attestation — the only place that does. It deploys to a **real Phala CVM** with **real TEE attestations** (not a simulation): the test script runs *outside* the TEE, deploys the contract and test image, configures measurements/PPIDs, then calls the running app and checks results. It needs a `PHALA_API_KEY` and a funded testnet NEAR account (see the root README). Update or add scenarios there whenever a change touches:

- Agent registration flow
- Compose-hash computation, PPID handling, measurement approval
- Key derivation / rotation
- The CLI deploy pipeline

