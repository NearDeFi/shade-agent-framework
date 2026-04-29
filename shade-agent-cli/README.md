# @neardefi/shade-agent-cli

CLI for deploying and managing Shade Agent contracts and agent apps (either locally or in TEEs). Create the contract account, deploy the agent contract (from source, WASM, or global hash), approve measurements and PPIDs, build the Docker image and deploy to Phala Cloud.

## Install

```bash
npm install -g @neardefi/shade-agent-cli
```

## Commands

- **`shade deploy`** — Run the full deployment from your `deployment.yaml`.
- **`shade reproduce`** — Produces the reproducible Docker image hash and the app compose hash. Used when verifying the code.
- **`shade plan`** — Show what the deployment will do without executing.
- **`shade whitelist`** — Whitelist an agent account for local mode (`whitelist_agent_for_local`).
- **`shade auth`** — Set NEAR credentials (master account per network) and optional Phala API key for TEE deploys.

Run `shade` with no arguments for the interactive menu.

## Setup

1. Put a `deployment.yaml` in your project root (see example below).
2. Run **`shade auth set`** to store the NEAR master account (and Phala key if using TEE).
3. Run **`shade deploy`** from the project directory.

## Reference

The CLI docs are available [here](../docs/reference/cli.md).

## Tests

Unit tests cover compose-hash computation, shell-arg construction, transaction-outcome decoding, placeholder substitution, PPID fetch, and the `shade deploy` orchestration including the destructive-redeploy confirmation flow:

```bash
npm test
```

Coverage:

```bash
npm run test:coverage
```

## Example deployment.yaml

You can find example deployment files in the [example-deployment-files](./example-deployment-files) directory.