# shade-agent-framework

> [!WARNING]  
> This technology has not yet undergone a formal audit. Please conduct your own due diligence and exercise caution before integrating or relying on it in production environments

The Shade Agent Framework is built to enable verifiable and trust minimized Web3 agents that can sign transactions across most chains. At the core the framework is the verification of trusted execution environments (TEE) in NEAR Protocol smart contracts and the usage of smart contract transaction singing via chain signatures. Guardrails can be implemented at the smart contract level to stop the execution of unauthorized actions even if the TEE is compromised.

This monorepo contains all the tooling and documentation for the Shade Agent Framework. It contains:

- [docs](./docs/) - The documentation for the Shade Agent Framework.
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

  We use `npm ci` so installs strictly match the committed lockfiles. In the shade-agent-framework root run: 

  ```bash
  cd shade-agent-cli
  npm ci
  cd ../shade-agent-js
  npm ci
  npm run build
  cd ../tests-in-tee
  npm ci
  cd test-image
  npm ci
  cd ../..
  ```

  Note: lockfiles capture one platform's optional-dependency resolution. If `npm ci` errors on a missing native binding (e.g. `@napi-rs/keyring-linux-arm64-gnu`), install the platform-specific binding once with `npm install <binding-name>` in the affected package, or regenerate that package's lockfile on your platform.

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
  pivortex/near-builder:latest \
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
  cd ../shade-agent-cli
  npm run test
  cd ../shade-attestation
  cargo test
  cd ../shade-contract-template
  cargo test
  cd ../tests-in-tee
  npm run test
  cd ..
  ```
