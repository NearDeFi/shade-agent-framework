# Agent Contract

The **agent contract** is the on-chain component of the Shade Agent Framework. It handles agent registration, measurement, and PPID approval, and enforces that only valid agents can call specific methods.

On this page, you'll walk through the key components of the reference agent contract and how to implement your own **agent-gated functions**. You may need to change other parts of the contract depending on your use case. The full source lives in the [shade-agent-template](https://github.com/NearDeFi/shade-agent-template/tree/2.0/agent-contract) repo.

---

## Flow 

High-level flow:
- The owner deploys and initializes the contract.
- The owner approves measurements and PPIDs.
- Each agent calls `register_agent` with a valid attestation.
- Valid agents can then call agent-gated methods.

---

## Initialization  

The `new` method initializes the contract and takes four arguments (the CLI can initialize the contract with defaults):
- **`requires_tee`**: Whether the contract runs in local or TEE mode. This switches the behavior of the contract so you can move easily between local and TEE deployments.
- **`attestation_expiration_time_ms`**: How long a registration stays valid for after an agent registers.
- **`owner_id`**: The account ID allowed to call owner-only methods. The owner should usually be a multisig.
- **`mpc_contract_id`**: The Chain Signatures MPC contract that the agent contract will call for multichain signing.

On initialization, the rest of the contract state is set to empty.

```rust
#[init]
#[private]
pub fn new(
    requires_tee: bool,
    attestation_expiration_time_ms: U64,
    owner_id: AccountId,
    mpc_contract_id: AccountId,
) -> Self {
    Self {
        requires_tee,
        attestation_expiration_time_ms: attestation_expiration_time_ms.into(),
        owner_id,
        mpc_contract_id, // Set to v1.signer-prod.testnet for testnet, v1.signer for mainnet
        approved_measurements: IterableSet::new(StorageKey::ApprovedMeasurements),
        approved_ppids: IterableSet::new(StorageKey::ApprovedPpids),
        agents: IterableMap::new(StorageKey::Agents),
        whitelisted_agents_for_local: IterableSet::new(StorageKey::WhitelistedAgentsForLocal),
    }
}
```

If your contract needs additional state, add it in the init method and extend the `Contract` struct accordingly.

---

## Measurements, PPID, Whitelist, and Agent Management

The **owner** of the contract can manage the approved measurements, PPIDs, whitelist, and agents.

### Measurements

The `approved_measurements` decide what code an agent is allowed to run. The CLI will approve a set of measurements for your agent when run. You can learn more about [measurements](../concepts/terminology.md#measurements).

The owner controls which measurements are approved and can add or remove them over time. A typical agent code upgrade flow is: approve a new set of measurements, allow a transition period (e.g. a week) so operators can update agents to run the new code, then remove the old measurements. 

```rust
// Add a new set of measurements to the approved list
pub fn approve_measurements(&mut self, measurements: FullMeasurementsHex) {
    self.require_owner();
    self.approved_measurements.insert(measurements);
}

// Remove a set of measurements from the approved list
pub fn remove_measurements(&mut self, measurements: FullMeasurementsHex) {
    self.require_owner();
    require!(
        self.approved_measurements.remove(&measurements),
        "Measurements not in approved list"
    );
}
```

### PPID

The `approved_ppids` decide which physical TEE CPUs an agent may run on. The CLI will approve a list of default PPIDs when run. You can learn more about [PPID](../concepts/terminology.md#ppid).

```rust
// Add an array of PPIDs to the approved list
pub fn approve_ppids(&mut self, ppids: Vec<Ppid>) {
    self.require_owner();
    for id in ppids {
        self.approved_ppids.insert(id);
    }
}

// Remove an array of PPIDs from the approved list.
pub fn remove_ppids(&mut self, ppids: Vec<Ppid>) {
    self.require_owner();
    for id in ppids {
        require!(self.approved_ppids.remove(&id), "PPID not in approved list");
    }
}
```

### Agent

Agents become authorized by calling `register_agent`; the owner can also remove an agent at any time. Use removal to clean up invalid agents or to revoke access if a TEE were to become compromised.

```rust
// Remove an agent from the registered list
pub fn remove_agent(&mut self, account_id: AccountId) {
    self.require_owner();
    require!(
        self.agents.remove(&account_id).is_some(),
        "Agent not registered"
    );
    Event::AgentRemoved {
        account_id: &account_id,
        reasons: vec![AgentRemovalReason::ManualRemoval],
    }
    .emit();
}
```

> [!NOTE]
> A removed agent can re-register by calling `register_agent` with a valid attestation.

### Whitelist

The **whitelist** applies only in **local mode**. It defines which account IDs may call **agent-gated methods**, since in local mode, the contract cannot verify that an agent is running approved code. Use `shade whitelist` in the CLI to add an account. You can learn more about [whitelisted accounts](../concepts/terminology.md#whitelisted-accounts).

```rust
// Whitelist an agent, it will still need to register afterwards
pub fn whitelist_agent_for_local(&mut self, account_id: AccountId) {
    if self.requires_tee {
        panic!("Whitelisting agents is not supported for TEE");
    }
    self.require_owner();
    // Only insert if not already whitelisted
    self.whitelisted_agents_for_local.insert(account_id);
}

// Remove an agent from the list of whitelisted agents
pub fn remove_agent_from_whitelist_for_local(&mut self, account_id: AccountId) {
    if self.requires_tee {
        panic!("Removing agents from the whitelist is not supported for TEE");
    }
    self.require_owner();
    require!(
        self.whitelisted_agents_for_local.remove(&account_id),
        "Agent not in whitelist for local"
    );
}
```

---

## Register Agent

Agents register by calling `register_agent`. The method checks that the agent has a valid attestation via `verify_attestation`; if it passes, the agent is stored with its measurements, PPID, and validity period (determined by `attestation_expiration_time_ms`).

An agent must attach 0.00486 NEAR to cover its own storage cost in the contract. If you change how much data is stored per agent, update the `STORAGE_BYTES_TO_REGISTER` constant accordingly.

```rust
// Register an agent, this needs to be called by the agent itself
#[payable]
pub fn register_agent(&mut self, attestation: DstackAttestation) -> bool {
    // Require the agent to pay for the storage cost
    // You should update the STORAGE_BYTES_TO_REGISTER const if you store more data
    let storage_cost = env::storage_byte_cost()
        .checked_mul(STORAGE_BYTES_TO_REGISTER)
        .unwrap();
    require!(
        env::attached_deposit() >= storage_cost,
        &format!(
            "Attached deposit must be greater than storage cost {:?}",
            storage_cost.exact_amount_display()
        )
    );

    // Verify the attestation and get the measurements and PPID for the agent
    let (measurements, ppid) = self.verify_attestation(attestation.clone());

    let valid_until_ms = block_timestamp_ms() + self.attestation_expiration_time_ms;

    Event::AgentRegistered {
        account_id: &env::predecessor_account_id(),
        measurements: &measurements,
        ppid: &ppid,
        current_time_ms: U64::from(block_timestamp_ms()),
        valid_until_ms: U64::from(valid_until_ms),
    }
    .emit();

    // Register the agent
    self.agents.insert(
        env::predecessor_account_id(),
        Agent {
            measurements,
            ppid,
            valid_until_ms,
        },
    );

    true
}
```

By default, an agent that provides a valid attestation can register. Meaning that anyone may be able to run an agent and register. Depending on your use case, you may want to add additional restrictions to an agent, for example, an allow-list of accounts, proof of a shared secret, or a limit of one agent per contract.

### Verify Attestation

`verify_attestation` decides if an agent is allowed to register. Its behavior depends on whether the contract is in TEE or local mode.

#### TEE Mode 

In TEE mode (`requires_tee = true`), the method accepts the agent only if it supplies a valid attestation, which is checked using the `verify` function provided by the [shade-attestation crate](https://github.com/NearDeFi/shade-agent-framework/tree/main/shade-attestation), which takes the list of approved measurements and PPIDs, the current timestamp (in seconds), and the expected `report_data`.

```rust
match attestation.verify(
    expected_report_data,
    block_timestamp_ms() / 1000,
    &expected_measurements,
    &approved_ppids,
) {
    Ok((verified_measurements, verified_ppid)) => {
        (verified_measurements.into(), verified_ppid)
    }
    Err(e) => {
        panic!("Attestation verification failed: {}", e);
    }
}
```

The attestation's **report data** must contain the NEAR account ID of the agent. This binds the attestation to the same TEE where the agent's key was created to prevent replay of valid attestations. Report data is passed as **bytes**.

```rust
// Verify account_ID is an implicit account ID
let account_id_str = env::predecessor_account_id().to_string();
require!(
    account_id_str.len() == 64
        && account_id_str
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()),
    "Account ID must be implicit account"
);

// Create the report data by converting the account ID to bytes and padding to 64 bytes
let account_id_bytes =
    hex::decode(&account_id_str).expect("Failed to decode account ID");
let mut report_data_bytes = [0u8; 64];
report_data_bytes[..32].copy_from_slice(&account_id_bytes);
let expected_report_data = ReportData::from(report_data_bytes);
```

#### Local Mode 

In local mode (`requires_tee = false`), the method approves the agent if the caller is whitelisted and the mock measurements and PPID are approved in the contract. No real attestation is verified.

```rust
require!(
    self.whitelisted_agents_for_local
        .contains(&env::predecessor_account_id()),
    "Agent needs to be whitelisted for local mode"
);
let default_measurements = create_mock_full_measurements_hex();
require!(
    self.approved_measurements.contains(&default_measurements),
    "Default measurements must be approved for local mode"
);
require!(
    self.approved_ppids.contains(&Ppid::default()),
    "Default PPID must be approved for local mode"
);
(default_measurements, Ppid::default())
```

---

## Require Valid Agent

You can restrict methods so only valid agents can call them using the helper `require_valid_agent`. An agent that registered earlier may no longer be valid. To gate a method: call `require_valid_agent`, and if it returns `Some(promise)`, execute the promise.

```rust
if let Some(failure_promise) = self.require_valid_agent() {
    return failure_promise;
}
```

> [!CAUTION]
> **Handle the promise** — You must execute the promise returned by `require_valid_agent` when it is `Some(promise)`; otherwise, the invalid agent can still call the function.

`require_valid_agent` first loads the agent from storage; if the caller is not registered, it panics.

```rust
let account_id = env::predecessor_account_id();
let agent = self.agents.get(&account_id).expect("Agent not registered");
```

It then checks whether the agent is still valid. It's valid if its registration has not expired (determined by `attestation_expiration_time_ms`), its measurements are still in the approved set, and its PPID is still approved.

**get_removal_reasons**

```rust
let removal_reasons = self.check_invalid_reasons(&account_id, &agent);
```

**check_invalid_reasons**

```rust
pub(crate) fn check_invalid_reasons(
    &self,
    account_id: &AccountId,
    agent: &Agent,
) -> Vec<AgentRemovalReason> {
    let mut reasons = Vec::new();
    if agent.valid_until_ms < block_timestamp_ms() {
        reasons.push(AgentRemovalReason::ExpiredAttestation);
    }
    if !self.approved_measurements.contains(&agent.measurements) {
        reasons.push(AgentRemovalReason::InvalidMeasurements);
    }
    if !self.approved_ppids.contains(&agent.ppid) {
        reasons.push(AgentRemovalReason::InvalidPpid);
    }
    if !self.requires_tee {
        if !self.whitelisted_agents_for_local.contains(account_id) {
            reasons.push(AgentRemovalReason::NotWhitelistedForLocal);
        }
    }
    reasons
}
```

If the agent is valid, then the function will return `None`. If the agent is invalid, it will be removed from the map of agents, an event will be emitted detailing the reasons for removal, and a promise will be returned from the function that will call `fail_on_invalid_agent` in the next block.

```rust
if !removal_reasons.is_empty() {
    self.agents.remove(&account_id);

    Event::AgentRemoved {
        account_id: &account_id,
        reasons: removal_reasons.clone(),
    }
    .emit();

    let args_json = serde_json::json!({
        "reasons": removal_reasons
    });
    let promise = Promise::new(env::current_account_id()).function_call(
        "fail_on_invalid_agent".to_string(),
        serde_json::to_vec(&args_json).expect("Failed to serialize reasons"),
        NearToken::from_near(0),
        Gas::from_tgas(10),
    );

    return Some(promise);
}
None
```

The promise calls `fail_on_invalid_agent`, which panics in the next block. Panicking in the next block (rather than the current one) ensures the agent is removed from storage; panicking in the current block would revert that removal.

```rust
#[private]
pub fn fail_on_invalid_agent(reasons: Vec<AgentRemovalReason>) {
    env::panic_str(&format!("Invalid agent: {:?}", reasons));
}
```
 
---

## Your Functions

The template includes an example `request_signature` function. It allows a **valid agent** to request a signature for a transaction payload from the MPC contract, so you can sign transactions for most chains. You can learn more about singing transactions for different chains in the [chain signatures documentation](https://docs.near.org/chain-abstraction/chain-signatures/implementation).

```rust
pub fn request_signature(
    &mut self,
    path: String,
    payload: String,
    key_type: String,
) -> Promise {
    // Require the caller to be a valid agent, if not, execute a promise to panic
    if let Some(failure_promise) = self.require_valid_agent() {
        return failure_promise;
    }

    self.internal_request_signature(path, payload, key_type)
}
```

You should implement your own **agent-gated functions** in this `your_functions.rs` file, following the same pattern: call `require_valid_agent`, then run your logic.

> [!TIP]
> **On chain guardrails** — A key part of the Shade Agent Framework is the ability to implement **on-chain guardrails**. This gives protection against unauthorized actions - even if the TEE is compromised. It's strongly recommended that you build actions within the agent contract rather than in the agent itself, for example, using the [omni-transaction-rs](https://github.com/Omni-rs/omni-transaction-rs) library.

---

## Building the Contract 

Usually, you build and deploy with the **Shade Agent CLI**: `shade deploy`. To build the contract manually, use the following command:

**Linux**

For Linux, you can compile the contract directly with [cargo near](https://github.com/near/cargo-near/releases/latest).

```bash
cargo near build non-reproducible-wasm --no-abi
```

**Mac**

Because of a required dependency in the shade-attestation crate, agent contracts cannot be built on Mac machines. You can build the contract inside a Docker container using the following command:

```bash
docker run --rm -v "$(pwd)":/workspace pivortex/near-builder:latest cargo near build non-reproducible-wasm --no-abi
```

If you would like to build the image yourself, you can use [this Dockerfile](https://github.com/NearDeFi/shade-agent-framework/blob/main/contract-builder/Dockerfile).

> [!NOTE]
> The `--no-abi` flag is used to build the contract without an ABI. This is required because the shade-attestation crate currently doesn't support ABI generation.

---

## Calling Methods 

The **Shade Agent CLI** calls the main contract methods when you run `shade deploy`, but it does not cover every method. For methods the CLI doesn't support, use the [NEAR CLI](https://docs.near.org/tools/near-cli) or create scripts using the [NEAR API](https://docs.near.org/tools/near-api). 
