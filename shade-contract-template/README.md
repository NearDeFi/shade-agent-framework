# shade-contract-template

Example NEAR smart contract for the Shade Agent Framework that uses a local version of the shade-attestation crate.

## Registering agents

If the contract is initialized with `require_tee = true`, then the `register_agent` function will verify that the attestation is true, has the expected report data, and has a set of approved measurements and an approved PPID. The report data is the account ID of the agent, so it should match the predecessor, so we know the attestation came from the TEE where it was generated.

If `requires_tee = false`, then `register_agent` will assign the agent default measurements and PPID and check they match the approved ones. For local, it additionally checks that the agent is whitelisted (to make sure only agents approved by the developer can interact with the agent contract).

Just because an agent is registered does not mean it's verified at a given moment in time. To verify the measurements and PPID it registered with still need to be approved, and the attestation must not have expired (as determined by the attestation_expiration_time_ms set on init). For local, the agent still needs to be whitelisted.

Each function that is only callable by registered agents, for example, `request_signature`, should implement the `require_valid_agent` check and return the promise it produces.

Note that in this example for the TEE case, any agent, as long as it passes attestation verification, can register, meaning that anyone can register an agent as long as they are running the same code with the same measurements.

## Building the contract

You currently need to build this contract without an ABI.

In the shade-agent-framework root

### Linux

```bash
cd shade-contract-template
cargo near build non-reproducible-wasm --no-abi
```

### Mac

The ring dependency is dcap-qvl, which cannot be built on mac so build the contract using this Docker image.

```bash
docker run --rm \
-v "$(pwd)":/workspace \
-w "/workspace/shade-contract-template" \
pivortex/near-builder@sha256:dad9153f487ec993334d11900b2a9a769c542dd8feecb71c9cd453f29300e156 \
cargo near build non-reproducible-wasm --no-abi
```

## Testing

You need to build the contract first

```bash
cargo test
```

Tests cover only `requires_tee = false` (can't produce valid TEE attestation outside of TEE).

### Unit tests

Contract init; owner-only methods (approve_measurements, remove_measurements, approve_ppids, remove_ppids, whitelist_agent_for_local, remove_agent_from_whitelist_for_local, remove_agent, update_owner_id, update_mpc_contract_id, update_attestation_expiration_time) and panics when non-owner calls; agent registration (success, twice, not whitelisted, insufficient deposit); views (get_contract_info, get_agent, get_agents, pagination, expiration fields); request_signature (no checking of valid promise) and require_valid_agent (not whitelisted, not registered, removal on invalid measurements/PPID/expired/not whitelisted/multiple reasons, success with Ecdsa/Eddsa, invalid key type).

### Integration tests

| Test                                                       | What it tests                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test_measurements_and_ppid_lifecycle`                     | Exercises the full measurements and PPID approval lifecycle. Verifies that `request_signature` fails with InvalidMeasurements, InvalidPpid, or both when approvals are revoked; that the agent is removed and the right events are emitted; that re-approving measurements and PPID restores access; and that a removed agent cannot re-register. |
| `test_register_fails_without_default_measurements_or_ppid` | Confirms that registration fails in local mode when the default measurements or the default PPID have not been approved by the owner.                                                                                                                                                                                                             |
| `test_attestation_expiration`                              | Fast-forwards the sandbox past the attestation expiration time, then checks that `request_signature` removes the agent with ExpiredAttestation, that the next call returns "Agent not registered", and that the agent can re-register afterward.                                                                                                  |
| `test_cross_contract_call_to_mpc`                          | Ensures that `request_signature` correctly calls the mock MPC contract for both Ecdsa and Eddsa, and that updating `mpc_contract_id` causes later calls to use the new contract.                                                                                                                                                                  |
| `test_large_dataset_pagination_real_contract`              | Registers 20 agents and checks that `get_agents` pagination works as expected using `from_index` and `limit`.                                                                                                                                                                                                                                     |
| `test_owner_transfer_and_new_owner_operations`             | Transfers contract ownership and verifies that the new owner can approve measurements while the old owner can no longer do so.                                                                                                                                                                                                                    |
| `test_update_contract`                                     | Deploys the contract, calls `update_contract` with new WASM, and checks that state is migrated correctly and that the new methods are available.                                                                                                                                                                                                  |
