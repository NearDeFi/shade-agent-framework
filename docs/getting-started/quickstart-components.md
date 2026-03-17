# Key Components

In this section, we'll explore the main components of the [quickstart template](https://github.com/NearDeFi/shade-agent-template) to understand how to develop a Shade Agent. We'll also look at how to modify the template to build an agent for your use case.

---

## Template Structure

The template we're using is a simple Shade Agent built with Hono and written in **TypeScript** that acts as a verifiable ETH price oracle. It takes prices from two different APIs, takes the average, and then pushes the price to an Ethereum contract. 

The agent has three main files:
1) [**index.ts**](https://github.com/NearDeFi/shade-agent-template/tree/main/src/index.ts) - This is the entry point that sets up the **Shade Agent Client**, **registers** the agent and defines the routes for the agent. We'll review this file in more detail in the next section.
2) [**transaction**](https://github.com/NearDeFi/shade-agent-template/tree/main/src/routes/transaction.ts) - This is where the core logic of the agent is defined. When this API is called, the agent will build a transaction payload and request a signature from the agent contract. We'll look deeper into this API route later on this page.
3) [**agentInfo**](https://github.com/NearDeFi/shade-agent-template/tree/main/src/routes/agentInfo.ts) - This API simply fetches the agent's NEAR account ID and its balance by using the `agent.accountId()` and `agent.balance()` methods from the `shade-agent-js` library.
4) [**ethAccount**](https://github.com/NearDeFi/shade-agent-template/tree/main/src/routes/ethAccount.ts) - This API returns the **Ethereum Sepolia account** that the Shade Agent uses to update the price of Ethereum in the Sepolia contract. This API is used so the user knows which account to fund for gas.

The repo also contains an **agent contract**. We won't review the agent contract as it's the same as the reference implementation [featured here](../../reference/agent-contract.md), but we encourage you to review the reference implementation after this section.

---

## Registering the Agent

First, in the [index.ts](https://github.com/NearDeFi/shade-agent-template/tree/main/src/index.ts) file, the **Shade Agent Client** is **initialized**. 

The client is initialized with the following arguments:
- `networkId` is set to `testnet` since the agent contract was deployed to testnet.
- `agentContractId` is set to the agent contract ID and is fetched from the environment variables.
- `sponsor` is set to the sponsor account details from the environment variables. It is used later to fund the agent.
- `derivationPath` is set to the sponsor's private key from the environment variables. For local deployment, this derives a deterministic account ID for the agent, making testing easier (for TEE deployment, this does nothing as ignored). The derivation path needs to be random and private; a private key fulfills this criterion well.

```ts
export const agent = await ShadeClient.create({
  networkId: "testnet",
  agentContractId: agentContractId, // Agent contract the agent will interact with
  sponsor: {
    // Sponsor account details that will fund the agent
    accountId: sponsorAccountId,
    privateKey: sponsorPrivateKey,
  },
  derivationPath: sponsorPrivateKey, // Random string kept secret (private key does a good job)
});
```

Next, the agent is **funded** with 0.3 NEAR via the `sponsor` account using the `agent.fund()` method. This is done to ensure the agent has enough NEAR to pay for gas when sending transactions.

```ts
const balance = await agent.balance();
if (balance < 0.2) {
  await agent.fund(0.3);
}
```

After this, the agent **registers** itself with the agent contract. To make it easier for local deployment, a loop is started that checks if the agent is whitelisted; if not, it will wait for 10 seconds and try again until it's whitelisted, at which point the agent will register.

```ts
while (true) {
  try {
    // Register the agent if whitelisted or if the agent contract requires TEE
    const isWhitelisted = await agent.isWhitelisted();
    if (isWhitelisted === null || isWhitelisted) {
      const registered = await agent.register();
      if (registered) {
        console.log("Agent registered");
        break;
      }
    }
  } catch (error) {
    console.error("Error:", error);
  }
  await new Promise((resolve) => setTimeout(resolve, 10000));
}
```

Since registrations expire (every 7 days by default), an interval is set to **re-register** the agent every 6 days.

```ts
const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
const reRegister = agent.register.bind(agent);
setInterval(async () => {
  try {
    const registered = await reRegister();
    if (registered) {
      console.log("Agent re-registered");
    }
  } catch (error) {
    console.error("Error re-registering agent:", error);
  }
}, SIX_DAYS_MS);
```

The agent is now registered and ready to sign transactions.

---

## Signing Transactions

In the [transaction API Route](https://github.com/NearDeFi/shade-agent-template/tree/main/src/routes/transaction.ts), the `agent.call()` method from the `shade-agent-js` library is used to call a function on the agent contract.

In this example, the agent is calling the `request_signature` function on the agent contract. This function takes a transaction payload for nearly any blockchain and requests a signature via [Chain Signatures](https://docs.near.org/chain-abstraction/chain-signatures/implementation). Here, we're signing a transaction to call an Ethereum contract to update the stored price of ETH. First, we retrieve the price of ETH (in this example, the function queries two different APIs and calculates the average).

```ts
const ethPrice = await getEthereumPriceUSD();
```

Next, we build the **transaction payload** to be signed. To do this, we're using the `chainsig.js` library.
Using this library, we:
1. **Derive the Ethereum address** that will be sending the transaction. This function takes the agent contract account ID since this is the predecessor account that is calling the Chain Signatures [MPC contract](https://github.com/Near-One/mpc/tree/main/libs/chain-signatures/contract), and a path. The path can be whatever string you like; different paths will derive different addresses.
2. Create the `data`. This is what action we're performing, in this case, a function call to update the price in the contract.
3. **Build the transaction and the transaction payload** by inputting the derived address, the target Ethereum smart contract, and the data.

```ts
// Derive the price pusher EVM address
const { address: senderAddress } = await Evm.deriveAddressAndPublicKey(
contractId,
"ethereum-1",
);
// Create a new JSON-RPC provider for the EVM network
const provider = new JsonRpcProvider(ethRpcUrl);
// Create a new contract interface for the EVM Oracle contract
const contract = new Contract(ethContractAddress, ethContractAbi, provider);
// Encode the function data for the updatePrice function
const data = contract.interface.encodeFunctionData("updatePrice", [ethPrice]);
// Prepare the transaction for signing
const { transaction, hashesToSign } = await Evm.prepareTransactionForSigning({
from: senderAddress,
to: ethContractAddress,
data,
});
```

Once we have the payload (also known as the hash), we can call the `request_signature` function on the agent contract to sign the transaction. We specify the `keyType` as `Ecdsa` as we're signing for a blockchain that uses the **secp256k1** signature scheme.

```ts
const signRes = await agent.call({
  methodName: "request_signature",
  args: {
    path: "ethereum-1",
    payload: uint8ArrayToHex(hashesToSign[0]),
    key_type: "Ecdsa",
  },
});
```

The result is the **signature**.

We then attach the signature to the Ethereum transaction and broadcast it to the target network.

```ts
const signedTransaction = Evm.finalizeTransactionSigning({
  transaction,
  rsvSignatures: [toRSV(signRes as MPCSignature)],
});

const txHash = await Evm.broadcastTx(signedTransaction);
```

---

## Modifying This Template 

### Using Different Chains

We set up a **chain adapter** for Ethereum Sepolia in the [Ethereum.ts](https://github.com/NearDeFi/shade-agent-template/tree/main/src/utils/ethereum.ts) file using the `chainsig.js` library. This library allows us to easily construct transaction payloads to be signed by the agent.

```ts
const publicClient = createPublicClient({
  transport: http(ethRpcUrl),
});

export const Evm = new chainAdapters.evm.EVM({
  publicClient,
  contract: MPC_CONTRACT,
}) as any;
```

You can set up chain adapters for a variety of chains, including NEAR, EVM, Bitcoin, Solana, SUI, XRP, and Cosmos, to allow your agent to interact with multiple different chains. You can see a full list of the chains currently supported [here](https://github.com/NearDeFi/chainsig.js/tree/main?tab=readme-ov-file#supported-chains), but feel free to contribute any chain that is not yet supported.

Implementation details differ slightly from chain to chain; as such, we recommend you review our [chain signature docs](https://docs.near.org/chain-abstraction/chain-signatures/implementation). Note that step 3 of requesting a signature is different; we use the `agent.call()` method from `shade-agent-js` instead.

If you are using a chain that uses the **ed25519** signature scheme (NEAR, Solana, SUI, Aptos, etc.), you should specify the `keyType` as `Eddsa` when calling `request_signature`.

### Implementing Guardrails 

As you move into production, it's recommended to implement on-chain guardrails in your agent contract to prevent malicious actions even if the TEE is compromised. You can read more about [on-chain guardrails](../concepts/terminology.md#on-chain-guardrails).

---

## Next Steps

Now that you've explored the basics of Shade Agents, we recommend diving deeper into the [framework overview](../../concepts/framework-overview.md) to understand the core components for building production-ready Shade Agents.
