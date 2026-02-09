# shade-agent-framework

The Shade Agent Framework is built to enable verifiable and trustless Web3 agents that can sign transactions across most chains. At the core the framework is the verification of trusted execution environments (TEE) in NEAR Protocol smart contracts and the usage of smart contract transaction singing via chain signatures. Guardrails can be implemented at the smart contract level to stop the execution of unauthorized actions even if the TEE is compromised.

This monorepo contains all the tooling for the Shade Agent Framework. It contains:

- [shade-agent-js](./shade-agent-js/) - A published library for creating agents in JavaScript and Typescript. It abstracts the complexity of TEEs and agent contracts.
- [shade-agent-cli](./shade-agent-cli/) - A published CLI to help deploy Shade Agents.
- [shade-attestation](./shade-attestation/) - A published Rust crate to verify Shade Agent TEE attestations in NEAR smart contracts.
- [shade-contract-template](./shade-contract-template/) - A minimal example agent contract that is easy to swap between local and TEE modes. Note that it relies on local dependencies and is used for development of the framework for a standalone example, see https://github.com/NearDeFi/shade-agent-template
- [shade-agent-template](./shade-agent-template/) - A minimal example price oracle agent. Note that it relies on local dependencies and is used for development of the framework for a standalone example, see https://github.com/NearDeFi/shade-agent-template
- [tests-in-tee](./tests-in-tee/) - A set of integration tests that run inside a TEE and hit shade-agent-js, shade-contract-template, and shade-attestation.

---

## Installation

### shade-agent-js

```bash
npm i @neardefi/shade-agent-js
```

### shade-agent-cli

```bash
npm i -g @neardefi/shade-agent-cli
```

### shade-attestation

```bash
cargo add shade-attestation
```

---

## Testing

- Before testing, install dependencies and build libraries

  In the shade-agent-framework root

  ```bash
  cd shade-agent-cli
  npm i
  cd ../shade-agent-js
  npm i
  npm run build
  cd ../tests-in-tee
  npm i
  cd test-image
  npm i
  cd ../..
  ```

- Build the contract

  In the shade-agent-framework root

  Linux

  ```bash
  cd shade-contract-template
  cargo near build non-reproducible-wasm --no-abi
  ```

  Mac

  ```bash
  docker run --rm \
  -v "$(pwd)":/workspace \
  -w "/workspace/shade-contract-template" \
  pivortex/near-builder@sha256:cdffded38c6cff93a046171269268f99d517237fac800f58e5ad1bcd8d6e2418 \
  cargo near build non-reproducible-wasm --no-abi
  ```

- Fill out environment variables

  Inside ./tests-in-tee fill out an env file

  ```env
  TESTNET_ACCOUNT_ID=
  TESTNET_PRIVATE_KEY=
  SPONSOR_ACCOUNT_ID=
  SPONSOR_PRIVATE_KEY=
  PHALA_API_KEY=
  ```

  TESTNET and SPONSOR can be the same; make sure the account has at least 20 testnet NEAR.

- Run all tests

  In the shade-agent-framework root

  ```bash
  cd shade-agent-js
  npm run test
  cd ../tests-in-tee
  npm run test
  cd ../shade-contract-template
  cargo test
  cd ..
  ```
