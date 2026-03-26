# Shade Agent API

## API Overview

**Shade Agent API** is a **TypeScript/JavaScript** library that connects your agent to the Shade Agent Framework. It abstracts TEE complexity and simplifies calls to the agent contract. The same API works locally and inside a TEE; its behavior differs slightly by environment, but the interface stays the same.

---

## Installation

```bash
npm install @neardefi/shade-agent-js
```

---

## Initializing the Client

Sets up the client with the desired configuration.

```ts
import { ShadeClient } from "@neardefi/shade-agent-js";

const agent = await ShadeClient.create({
  networkId: "testnet", // or "mainnet"
  agentContractId: process.env.AGENT_CONTRACT_ID, // example-agent-contract.testnet 
  sponsor: {
    accountId: process.env.SPONSOR_ACCOUNT_ID, // example-sponsor.testnet
    privateKey: process.env.SPONSOR_PRIVATE_KEY, // ed25519:4vKz...
  },
  rpc: provider, 
  numKeys: 10,
  derivationPath: process.env.SPONSOR_PRIVATE_KEY, // ed25519:4vKz...
});
```

### **Arguments**

All arguments are optional. Omitting some makes certain methods unavailable.

| Argument | Description |
|----------|-------------|
| `networkId` | The NEAR network: `mainnet` or `testnet` (defaults to testnet). |
| `agentContractId` | The account ID of your agent contract that your agent will interact with. |
| `sponsor` | The account details of a sponsor account to fund the agent. |
| `rpc` | A [near-api-js provider](https://near.github.io/near-api-js/modules/providers.html) object used by the client (defaults to a basic RPC provider based on the network). |
| `numKeys` | The number of key pairs the agent has (1–100, defaults to 1). More keys increase transaction throughput; the client rotates through them when signing transactions. |
| `derivationPath` | A string used to derive deterministic agent account IDs when running locally. Lets you avoid re-whitelisting and re-funding the agent on each run. Use a unique secret (e.g. a private key). If two agents share the same derivation path, they get the same account ID and could control contracts they are not authorized for. |

---

## Agent Account ID

Returns the ephemeral NEAR account ID of the agent.

```ts
const accountId = agent.accountId();
```

---

## Agent Balance

Returns the NEAR balance of the agent's account in human-readable units (e.g. 1 = one NEAR). If the account does not exist, it returns 0.

```ts
const balance = await agent.balance();
```

---

## Fund Agent

Transfers NEAR from the configured sponsor account to the agent's account. 

```ts
await agent.fund(0.3); // 0.3 NEAR
```

Requires `sponsor` in config.

---

## Check Whitelist

Checks whether the agent's account is whitelisted for local mode.

```ts
const whitelisted = await agent.isWhitelisted();
```

**TEE vs local:** 
- TEE: Always returns `null`.
- Local: Returns `true` if the agent is whitelisted, `false` otherwise.

Requires `agentContractId` in config.

---

## Register Agent

Registers the agent's account on the agent contract by calling `register_agent` with an attestation. Returns `true` on success, throws on failure.

```ts
await agent.register();

await agent.register({
  deposit: "6000000000000000000000", // optional yoctoNEAR when storage stake is needed
  forceDeposit: true, // optional; see below
});
```

### Optional parameters

All fields are optional. Omit the argument entirely (`register()`) or pass an empty object (`register({})`) for default behavior.

| Parameter | Description |
|-----------|-------------|
| `deposit` | Attached deposit in **yoctoNEAR** when the call must include a storage stake: first-time registration in auto mode, or whenever `forceDeposit` is `true`. If omitted in those cases, the client uses **`5000000000000000000000` yoctoNEAR** (0.005 NEAR). Raise this if your contract’s required storage stake is higher than that default. |
| `forceDeposit` | Controls whether the client calls `get_agent` to decide how much to attach. See the table below. |

### How the attached deposit is chosen

| `forceDeposit` | Behavior |
|----------------|----------|
| *Omitted* or `undefined` | The client calls **`get_agent`** for the agent’s account ID. If the agent **is not** registered (`null`), it attaches **`deposit` or the default** (0.005 NEAR in yocto). If the agent **is** already registered (re-registration / refresh), it attaches **no** deposit (`0`), because the contract does not charge extra storage for an existing key. |
| `true` | **Skips** `get_agent`. Always attaches **`deposit` or the default** (0.005 NEAR yocto). Use when you know the contract expects a storage stake regardless of prior state. |
| `false` | **Skips** `get_agent`. Always attaches **0**. Use when you know the contract will not require a deposit for this call (e.g. re-register after the contract was updated to waive deposit for existing agents). If the contract still requires a stake, the transaction will fail. |

**TEE vs local (attestation):**

- **TEE:** Registers the agent with a real attestation.
- **Local:** Registers the agent with a mock attestation.

Requires `agentContractId` in config.

---

## Call Agent Contract

Calls a **change function** on the agent contract (uses gas, can change state). Returns the call result or throws.

```ts
const result = await agent.call({
  methodName: "example_call_function",
  args: { arg1: "value1", arg2: "value2" },
  gas: BigInt("300000000000000"), // Optional
  deposit: "0", // Optional
});
```

Requires `agentContractId` in config.

---

## View Agent Contract

Calls a **view function** on the agent contract (no gas, read-only). Returns the call result or throws.

```ts
const result = await agent.view({
  methodName: "example_view_function",
  args: { arg1: "value1", arg2: "value2" },
});
```

Requires `agentContractId` in config.

---

## Get Attestation

Returns the attestation in the format the agent contract expects.

```ts
const attestation = await agent.getAttestation();
```

**TEE vs local:** 
- TEE: Returns a real attestation. 
- Local: Returns a mock attestation. 

---

## Get Private Keys

Returns the agent's ephemeral private keys. Useful for when wanting to use other NEAR tooling (e.g. near-api-js) or for other operations like encrypting messages.

> [!CAUTION]
> Never log, expose, or store these keys. Doing so allows registered keys to be used outside of verified code (the keys can execute any operation not authorized by the measurements). Do not hold funds or important state with these keys — they are ephemeral and lost if the TEE reboots.

```ts
const keys = agent.getPrivateKeys({ acknowledgeRisk: true });
```

---

## Utilities

### sanitize

Aims to redact private keys from strings, objects, or Errors. Use before logging.

```ts
import { sanitize } from "@neardefi/shade-agent-js";
console.error(sanitize(someError));
```

> [!WARNING]
> Sanitize redacts common key patterns, but can't catch every case or other sensitive data. Add your own sanitization where needed so no sensitive data is emitted from the TEE.

### toThrowable

Returns an error with a sanitized message. Use when rethrowing.

```ts
import { toThrowable } from "@neardefi/shade-agent-js";
try {
  await client.register();
} catch (e) {
  throw toThrowable(e);
}
```
