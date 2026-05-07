# Security Considerations

A note on how to calibrate the considerations below: several are framed against a malicious host that tampers with what the application
sees (env vars, network, time, disk). TEE confidentiality is not absolute — recent disclosures like TEE.fail have shown that a host with 
physical access can extract secrets from Intel TDX through hardware side-channel attacks, including an agent's private keys. So defending against a maclious host may not be worth the time depending on your security tolerance. All considerations based on a malicious host are marked **host**.

## Restricting Actions

While TEEs are considered trusted and tamper-resistant, implementing tight restrictions or **guardrails** on agent actions within the agent contract is recommended so that even in the event a TEE is compromised and the private key to an agent is extracted, funds can't be withdrawn. You can read more about guardrails [here](terminology.md#on-chain-guardrails).

---

## Preventing Duplicate Actions

To ensure liveness, a Shade Agent should consist of multiple identical agents hosted by different providers/on different hardware. When multiple agents are running, all agents will respond to triggers (user inputs, cron jobs, API calls, etc.). You must ensure that the Shade Agent collectively performs the desired action only **once** in response to each update.

Consider a mindshare trading agent as an example. If Solana's mindshare increases relative to NEAR, the agent would swap SOL for NEAR. With two agents running, you must ensure this swap doesn't occur twice.

This logic is typically best implemented within the agent contract by only allowing one agent to perform the action at a time.

---

## Handling Failed or Unsent Transactions

A successful MPC signature on a transaction payload doesn't guarantee the transaction's success or transmission. Transactions may fail for various reasons, such as network congestion, incorrect nonce, or insufficient gas.

It's suggested you build your agent in such a way that if the transaction fails, then a new signature can be requested without allowing for more signing for the same action when the transaction is successful.

For some use cases, it may be beneficial to emit signed transactions from your agent contract, allowing anyone or an indexer to relay them if your agent fails to retrieve the result. Signed transactions can be built using [omni-transactions-rs](https://github.com/near/omni-transaction-rs). Exercise caution with unsent signatures.

---

## Restricting API Routes

In the quickstart, the agent can take an API request from anyone, allowing someone to drain the funds from the agent's account and the Ethereum Sepolia account through gas expenditure. If using API routes, you need to design your agent to only perform the action when the desired condition is met or implement authentication inside the route, for example, a user has signed an action with their wallet or they are logged in from their Google account.

---

## Removing Agent Contract Keys

Before deploying your agent contract to production, you should ensure that all **access keys** to the agent contract account have been removed. Otherwise, this would allow the access key owner to withdraw the funds held by the Shade Agent. This can be done using the CLI.

In the agent contract reference implementation, the contract code, approved measurements, and PPID can be updated by the owner. It's recommended that the owner be a **multisig**.

---

## Removing Local Deployment

When deploying to production, it's recommended to remove the **local deployment flow** from the agent contract entirely. Strip out the code that supports local mode (whitelist checks, default measurements, and PPID for local, and any `requires_tee: false` branches) so the contract only accepts TEE attestations. That way, there is no way to misconfigure or re-enable local mode, and no code path that trusts a whitelist instead of attestation.

---

## Approved Measurements Limits

The attestation verification process iterates over all approved measurements and verifies that the TEE's measurements match the approved measurements. If the approved measurements list grows too large, registration could fail due to the function call running into the **gas limit**. It's recommended to limit the number of approved measurements to a reasonable number.

---

## Public Logs

By default, the Shade Agent CLI allows you to deploy the agent with **public logs** enabled. You should not emit any sensitive information in the logs when this is enabled. You can turn off public logs in the deployment.yaml.

---

## Storing Agent Keys

The agent's **ephemeral keys should not be stored** anywhere, including on the host machine. This could lead to code that is not approved in the contract accessing keys that are approved in the contract.

---

## On-Disk State

### Don't rely on disk persistence

The CVM may be rescheduled to a different instance and there is no guarantee that the disk follows. State written yesterday may simply not be there when the agent boots tomorrow. Your agent should be able to recover from a cold start.

### Don't store secrets that survive upgrades

Disk state is **not wiped on app upgrades**. When you push a new Docker image the new container inherits any persistent volumes the old one created. A future malicious upgrade can read everything previous versions wrote: derived keys, cached credentials, user data, anything. This does not require new measurements to be approved in the contract, just the agent deployer updating the image.

If a value would be catastrophic for a future version of code to read, don't put it on disk. You should treat all data on disk as being potentially leaked unless you soely operate the deployed agent. 

Note that logs are stored on disk, including in the private logging setup.

---

## Public PPIDs

All PPIDs that are approved in the agent contract are made **public**. If you are using your own hardware, consider whether you are comfortable with its PPID being public since it could be used to track your hardware.

---

## Fixed Docker Images

Never reference Docker images by `latest` (e.g. pivortex/my-first-agent:latest) in your **Docker Compose** file; this can lead to different images being loaded in the TEE for the same measurements. Always reference versions of the image you want to use via **hash** (e.g. pivortex/my-first-agent@sha256:bf3faac9793f0fb46e89a4a4a299fad69a4bfd1e26a48846b9adf43b63cb263b).

---

## Trusting RPCs

Inside an agent, it's common to want to query the state of the blockchain and perform actions based on the state. Since **RPCs can lie** about the state of the blockchain and do not have crypto-economic security, it's suggested you design your agent to defend against this. Below are some solutions, which solution you use will differ depending on your use case and the design of your agent:

### Verifying the State

In some cases, you will be able to submit the state back to the smart contract from which the state was queried and verify that it matches the actual state. For example, the verifiable DAO example submits a hash of the proposal back to the DAO, so the DAO can verify that the decision was made based on the true state of the blockchain.

### Trustless Providers

You can use RPC providers that leverage cryptographic proofs or run in TEEs themselves to know that the result mirrors the true state of the blockchain.

### Multiple Reputable Providers

You can use multiple reputable RPC providers and check the result across each provider to make sure they match.

---

## Trusting Wall-Clock Time

**host**

The host can influence the guest's wall clock. The boot-time clock comes from the host, and a malicious host can block egress to the trusted NTS servers so chrony can never correct the offset. Treat **wall-clock time as host-influenced state**: any security decision based on "what time is it" can be manipulated.

### Use Monotonic Time for Intervals

For "run every N seconds/minutes" loops, use a **monotonic clock** (e.g. `setInterval`, `performance.now()` in Node). Monotonic time measures elapsed time so the host can't manipulate your loop's cadence. Only reach for wall time when the work itself needs to know "what time is it right now."

### Authenticate Wall Time at the Source

When you do need wall time for a security decision (e.g. "is it 03:00 UTC yet?", "has this credential expired?"), don't read it from the local clock. Use a verifiable source of time or check the wall clock against another clock.

---

## Environment Variables

## Relying on Environment Variables 

Do not let your applications logic be dictated by environment variables in hazardous ways. Environment variable values themselves are not measured therefore can be changed from instance to instance while passing attestation verification. If an application relied on an RPC URL provided by an  environment variable an operator could provide a malicious RPC URL that produces whatever values they like.

## Host Changing Environemnt Variables

**host**

The host can change environment variables. They cannot change them to specific values since they are encrypted but they can change them to values you did not submit. As such you should sense check your environment variables. For example, does the CONTRACT_ID env end in ".near", does the PRIVATE_KEY env start with "ed22519:"?

---

## Validating TLS for External Calls

**host**

Inside the CVM, the host controls **DNS resolution** and the network path. Without proper **TLS certificate validation** on outbound HTTPS calls, the host can transparently MITM any external service the agent talks to. Never disable certificate verification or accept self-signed certs in production. With cert validation working correctly, the host's options collapse from "rewrite responses" to "drop or delay traffic."

For services where you want stronger guarantees than the default trust roots, **pin the expected certificate or public key** so a compromised CA can't issue a fraudulent cert that the host would otherwise pass through.

Note, this is not implemented for the NEAR RPC used in shade-agent-js.

---

## Verifying the CVM from External Callers

**host**

When external clients connect to a shade-agent over HTTPS, default TLS only proves they reached the published domain — not that they reached a CVM running approved code. A malicious host can route traffic to a different CVM and standard CA validation passes regardless.

The typical shade-agent pattern avoids this entirely: the agent's effect is a signed on-chain transaction the caller verifies on-chain, so the API response is just a trigger and TLS-level CVM verification isn't load-bearing.

If your agent's API responses are themselves the security boundary (the caller acts on the response without an on-chain check), see [Phala's domain attestation](https://docs.phala.com/phala-cloud/networking/domain-attestation) for the verification flow.

---

## Replay of Stale Responses

**host**

Even with TLS, the host can record a valid response and **replay it later**. An old block, an old balance, an old signed message — all decrypt cleanly and look fresh. For anything where freshness matters, include a recent anchor in the request (a nonce, a current block height, a per-request challenge) and reject responses that don't reference the anchor or reference one too old.

---

## Liveness and Host Denial

**host**

The host can pause, throttle, or refuse to schedule the CVM at any time. Wall time may jump arbitrarily across a pause, signed transactions may never be relayed, and outbound RPC calls may be silently dropped. None of this is detectable from inside the CVM in real time. Design the agent so **denial of execution is safe**, not catastrophic.

