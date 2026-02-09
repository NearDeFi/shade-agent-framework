# @neardefi/shade-agent-js

JavaScript/TypeScript library for building Shade Agent agents. Handles TEE attestation, ephemeral key derivation, and on-chain calls. Use it inside a TEE that supports Dstack or locally.

## Install

```bash
npm install @neardefi/shade-agent-js
```

## Usage

```ts
import { ShadeClient } from "@neardefi/shade-agent-js";

const client = await ShadeClient.create({
  networkId: "testnet",
  agentContractId: "agent-contract.testnet",
  sponsor: {
    accountId: "sponsor.testnet",
    privateKey: process.env.SPONSOR_PRIVATE_KEY,
  },
  numKeys: 10,
});

console.log(client.accountId());

await client.register();

const result = await client.call({
  methodName: "request_signature",
  args: { path: "...", payload: "0x...", key_type: "Ecdsa" },
  gas: BigInt("300000000000000"),
});
```

**ShadeClient:** `create(config)`, `accountId()`, `balance()`, `register()`, `call()`, `view()`, `getAttestation()`, `fund(amount)`, `isWhitelisted()`, `getPrivateKeys(acknowledgeRisk)` (use with care).

**Types:** `ShadeConfig`, `Measurements`, `FullMeasurements`, `DstackAttestationForContract`.

**Utilities:** `sanitize(value)`, `toThrowable(error)` for safe error handling.

## Key derivation and attestation

The library will detect if the library is running in a Dstack trusted execution environment. If it is in a TEE then key derivation will be random (via TEE and crypto entropy), and it will produce a real attestation. If its not in a TEE then key derivation is still random (crypto entropy) by default or deterministic if a derivation path is specified and it will produce a false default attestation (all zeros).

## Tests

Unit tests cover the whole library:

```bash
npm test
```

Coverage:

```bash
npm run test:coverage
```
