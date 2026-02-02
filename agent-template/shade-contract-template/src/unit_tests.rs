use crate::*;
use near_sdk::test_utils::{VMContextBuilder, accounts};
use near_sdk::testing_env;
use shade_attestation::{
    attestation::DstackAttestation,
    measurements::{FullMeasurementsHex, MeasurementsHex},
    tcb_info::HexBytes,
};

// Only testing requires_tee = false since we cannot produce a valid attestation for a TEE in unit tests

// Helper function to create a mock context
fn get_context(predecessor: AccountId, is_view: bool) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(accounts(0))
        .signer_account_id(predecessor.clone())
        .predecessor_account_id(predecessor)
        .is_view(is_view);
    builder
}

/// Returns measurements that differ from default (one byte different in mrtd).
fn non_default_measurements() -> FullMeasurementsHex {
    let mut mrtd = [0u8; 48];
    mrtd[0] = 1;
    FullMeasurementsHex {
        rtmrs: MeasurementsHex {
            mrtd: HexBytes::from(mrtd),
            rtmr0: HexBytes::from([0; 48]),
            rtmr1: HexBytes::from([0; 48]),
            rtmr2: HexBytes::from([0; 48]),
        },
        key_provider_event_digest: HexBytes::from([0; 48]),
        app_compose_hash_payload: HexBytes::from([0; 32]),
    }
}

/// Returns PPID that differs from default (all zeros).
fn non_default_ppid() -> Ppid {
    HexBytes::from([1u8; 16])
}

// Helper function to initialize contract (with default measurements and PPID approved for local mode)
fn setup_contract() -> Contract {
    let owner = accounts(0);
    let mpc_contract = accounts(1);
    let context = get_context(owner.clone(), false);
    testing_env!(context.build());
    let mut contract = Contract::new(false, owner, mpc_contract);
    contract.approve_measurements(FullMeasurementsHex::default());
    contract.approve_ppids(vec![Ppid::default()]);
    contract
}

// Test contract initialization with correct owner, MPC contract, and empty collections
#[test]
fn test_new() {
    let owner = accounts(0);
    let mpc_contract = accounts(1);
    let context = get_context(owner.clone(), false);
    testing_env!(context.build());

    let contract = Contract::new(false, owner.clone(), mpc_contract.clone());

    assert_eq!(contract.owner_id, owner);
    assert_eq!(contract.mpc_contract_id, mpc_contract);
    assert_eq!(contract.requires_tee, false);
    assert_eq!(contract.get_approved_measurements(&None, &None).len(), 0);
    assert_eq!(contract.get_approved_ppids().len(), 0);
    assert_eq!(contract.get_agents(&None, &None).len(), 0);
    assert_eq!(contract.get_whitelisted_agents_for_local().len(), 0);
}

// Test that owner can approve measurements and it appears in the approved list
#[test]
fn test_approve_measurements() {
    let mut contract = setup_contract();

    let measurements = FullMeasurementsHex::default();
    contract.approve_measurements(measurements.clone());

    assert!(
        contract
            .get_approved_measurements(&None, &None)
            .contains(&measurements)
    );
    assert_eq!(contract.get_approved_measurements(&None, &None).len(), 1);
}

// Test that non-owner cannot approve measurements
#[test]
#[should_panic(expected = "Caller is not the owner")]
fn test_approve_measurements_not_owner() {
    let mut contract = setup_contract();
    let non_owner = accounts(2);
    let context = get_context(non_owner, false);
    testing_env!(context.build());

    contract.approve_measurements(FullMeasurementsHex::default());
}

// Test that owner can remove measurements from the approved list
#[test]
fn test_remove_measurements() {
    let mut contract = setup_contract();

    let extra = FullMeasurementsHex::default();
    contract.approve_measurements(extra.clone());
    let count_before = contract.get_approved_measurements(&None, &None).len();
    assert_eq!(count_before, 1);

    contract.remove_measurements(extra.clone());
    assert!(
        !contract
            .get_approved_measurements(&None, &None)
            .contains(&extra)
    );
}

// Test that non-owner cannot remove measurements from the approved list
#[test]
#[should_panic(expected = "Caller is not the owner")]
fn test_remove_measurements_not_owner() {
    let mut contract = setup_contract();
    let non_owner = accounts(2);
    contract.approve_measurements(FullMeasurementsHex::default());

    let context = get_context(non_owner, false);
    testing_env!(context.build());
    contract.remove_measurements(FullMeasurementsHex::default());
}

// Test that remove_measurements panics when measurements are not in the approved list
#[test]
#[should_panic(expected = "Measurements not in approved list")]
fn test_remove_measurements_not_found() {
    let mut contract = setup_contract();
    // Try to remove measurements that were never approved
    contract.remove_measurements(non_default_measurements());
}

// Test that remove_ppids panics when PPID is not in the approved list
#[test]
#[should_panic(expected = "PPID not in approved list")]
fn test_remove_ppids_not_found() {
    let mut contract = setup_contract();
    // Try to remove PPID that was never approved
    contract.remove_ppids(vec![non_default_ppid()]);
}

// Test that owner can whitelist an agent for local and agent appears in whitelist (not yet registered)
#[test]
fn test_whitelist_agent() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    let whitelisted = contract.get_whitelisted_agents_for_local();
    assert!(whitelisted.contains(&agent));
    // Not registered yet, so get_agent returns None
    assert!(contract.get_agent(agent.clone()).is_none());
}

// Test that whitelisting an agent twice doesn't create duplicates
#[test]
fn test_whitelist_agent_twice() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());
    contract.whitelist_agent_for_local(agent.clone()); // Should not panic

    let whitelisted = contract.get_whitelisted_agents_for_local();
    assert_eq!(whitelisted.len(), 1);
}

// Test that whitelisting an already registered agent doesn't unregister it
#[test]
fn test_whitelist_agent_after_registration() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    // Whitelist agent
    contract.whitelist_agent_for_local(agent.clone());

    // Register agent (default measurements and PPID already approved in setup)
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    contract.register_agent(DstackAttestation::default());

    // Verify agent is registered
    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(agent_info.measurements_are_approved);
    assert!(agent_info.ppid_is_approved);

    // Whitelist agent again (should not unregister)
    let context = get_context(accounts(0), false);
    testing_env!(context.build());
    contract.whitelist_agent_for_local(agent.clone());

    // Verify agent is still registered
    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(agent_info.measurements_are_approved);
    assert!(agent_info.ppid_is_approved);
}

// Test that non-owner cannot whitelist an agent
#[test]
#[should_panic(expected = "Caller is not the owner")]
fn test_whitelist_agent_not_owner() {
    let mut contract = setup_contract();
    let non_owner = accounts(2);
    let agent = accounts(3);
    let context = get_context(non_owner, false);
    testing_env!(context.build());

    contract.whitelist_agent_for_local(agent);
}

// Test that remove_agent_for_local panics when agent is not in the whitelist
#[test]
#[should_panic(expected = "Agent not in whitelist for local")]
fn test_remove_agent_for_local_not_found() {
    let mut contract = setup_contract();
    let agent = accounts(2);
    // Agent was never whitelisted
    contract.remove_agent_for_local(agent);
}

// Test that owner can remove an agent from the whitelist (local)
#[test]
fn test_remove_agent_from_whitelist() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());
    assert!(contract.get_whitelisted_agents_for_local().contains(&agent));

    contract.remove_agent_for_local(agent.clone());
    assert!(!contract.get_whitelisted_agents_for_local().contains(&agent));
    assert!(contract.get_agent(agent).is_none());
}

// Test that non-owner cannot remove an agent from the whitelist
#[test]
#[should_panic(expected = "Caller is not the owner")]
fn test_remove_agent_for_local_not_owner() {
    let mut contract = setup_contract();
    let non_owner = accounts(2);
    let agent = accounts(3);
    contract.whitelist_agent_for_local(agent.clone());

    let context = get_context(non_owner, false);
    testing_env!(context.build());
    contract.remove_agent_for_local(agent);
}

// Test that owner can remove a registered agent from the agents map
#[test]
fn test_remove_agent() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    contract.register_agent(DstackAttestation::default());
    assert!(contract.get_agent(agent.clone()).is_some());

    let context = get_context(accounts(0), false);
    testing_env!(context.build());
    contract.remove_agent(agent.clone());
    assert!(contract.get_agent(agent).is_none());
}

// Test that remove_agent panics when agent is not registered
#[test]
#[should_panic(expected = "Agent not registered")]
fn test_remove_agent_not_found() {
    let mut contract = setup_contract();
    let agent = accounts(2);
    // Agent was never registered
    contract.remove_agent(agent);
}

// Test that non-owner cannot remove a registered agent
#[test]
#[should_panic(expected = "Caller is not the owner")]
fn test_remove_agent_not_owner() {
    let mut contract = setup_contract();
    let non_owner = accounts(2);
    let agent = accounts(3);
    contract.whitelist_agent_for_local(agent.clone());
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    contract.register_agent(DstackAttestation::default());

    let context = get_context(non_owner, false);
    testing_env!(context.build());
    contract.remove_agent(agent);
}

// Test that a whitelisted agent can register
#[test]
fn test_register_agent_without_tee() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    // Owner whitelists the agent (default measurements and PPID already approved in setup)
    contract.whitelist_agent_for_local(agent.clone());

    // Agent registers with fake attestation
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());

    let result = contract.register_agent(DstackAttestation::default());
    assert!(result);

    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(agent_info.measurements_are_approved);
    assert!(agent_info.ppid_is_approved);
}

// Test that an agent can register twice and the registration is updated
#[test]
fn test_register_agent_twice() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    // Register agent first time
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    let result = contract.register_agent(DstackAttestation::default());
    assert!(result);

    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(agent_info.measurements_are_approved);
    assert!(agent_info.ppid_is_approved);

    // Register agent again
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    let result = contract.register_agent(DstackAttestation::default());
    assert!(result);

    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(agent_info.measurements_are_approved);
    assert!(agent_info.ppid_is_approved);
}

// Test that an agent cannot register if not whitelisted for local
#[test]
#[should_panic(expected = "Agent needs to be whitelisted for local mode")]
fn test_register_agent_not_whitelisted() {
    let mut contract = setup_contract();
    let agent = accounts(2);
    let context = get_context(agent, false);
    testing_env!(context.build());

    contract.register_agent(DstackAttestation::default());
}

// Test that owner can update the owner ID
#[test]
fn test_update_owner_id() {
    let mut contract = setup_contract();
    let new_owner = accounts(3);

    contract.update_owner_id(new_owner.clone());
    assert_eq!(contract.owner_id, new_owner);
}

// Test that non-owner cannot update the owner ID
#[test]
#[should_panic(expected = "Caller is not the owner")]
fn test_update_owner_id_not_owner() {
    let mut contract = setup_contract();
    let non_owner = accounts(2);
    let new_owner = accounts(3);
    let context = get_context(non_owner, false);
    testing_env!(context.build());

    contract.update_owner_id(new_owner);
}

// Test that owner can update the MPC contract ID
#[test]
fn test_update_mpc_contract_id() {
    let mut contract = setup_contract();
    let new_mpc = accounts(4);

    contract.update_mpc_contract_id(new_mpc.clone());
    assert_eq!(contract.mpc_contract_id, new_mpc);
}

// Test that non-owner cannot update the MPC contract ID
#[test]
#[should_panic(expected = "Caller is not the owner")]
fn test_update_mpc_contract_id_not_owner() {
    let mut contract = setup_contract();
    let non_owner = accounts(2);
    let new_mpc = accounts(4);
    let context = get_context(non_owner, false);
    testing_env!(context.build());

    contract.update_mpc_contract_id(new_mpc);
}

// Test that get_requires_tee returns the correct value
#[test]
fn test_get_requires_tee() {
    let contract = setup_contract();
    assert_eq!(contract.get_requires_tee(), false);
}

// Test that get_approved_measurements returns approved measurements and pagination works
#[test]
fn test_get_approved_measurements() {
    let mut contract = setup_contract();

    let default = FullMeasurementsHex::default();
    contract.approve_measurements(default.clone());

    let all = contract.get_approved_measurements(&None, &None);
    assert_eq!(all.len(), 1);
    assert!(all.contains(&default));

    // Test pagination
    let first_two = contract.get_approved_measurements(&Some(0), &Some(2));
    assert_eq!(first_two.len(), 1);
}

// Test that get_agents returns only registered agents, pagination works, and measurements_are_approved / ppid_is_approved reflect current approvals
#[test]
fn test_get_agents() {
    let mut contract = setup_contract();
    let agent1 = accounts(2);
    let agent2 = accounts(3);
    let agent3 = accounts(4);

    contract.whitelist_agent_for_local(agent1.clone());
    contract.whitelist_agent_for_local(agent2.clone());
    contract.whitelist_agent_for_local(agent3.clone());

    // None registered yet
    assert_eq!(contract.get_agents(&None, &None).len(), 0);

    // Register agent1 and agent2; agent3 remains unregistered
    let context = get_context(agent1.clone(), false);
    testing_env!(context.build());
    contract.register_agent(DstackAttestation::default());

    let context = get_context(agent2.clone(), false);
    testing_env!(context.build());
    contract.register_agent(DstackAttestation::default());

    assert!(contract.get_agent(agent3.clone()).is_none());

    let agents = contract.get_agents(&None, &None);
    assert_eq!(agents.len(), 2);

    let agent1_info = agents.iter().find(|a| a.account_id == agent1).unwrap();
    assert!(agent1_info.measurements_are_approved);
    assert!(agent1_info.ppid_is_approved);

    let agent2_info = agents.iter().find(|a| a.account_id == agent2).unwrap();
    assert!(agent2_info.measurements_are_approved);
    assert!(agent2_info.ppid_is_approved);

    // Pagination
    assert_eq!(contract.get_agents(&Some(0), &Some(1)).len(), 1);

    // Remove default measurements; approval flags should update
    let context = get_context(accounts(0), false);
    testing_env!(context.build());
    contract.remove_measurements(FullMeasurementsHex::default());

    let agents = contract.get_agents(&None, &None);
    let agent1_info = agents.iter().find(|a| a.account_id == agent1).unwrap();
    assert!(!agent1_info.measurements_are_approved);
    assert!(agent1_info.ppid_is_approved);

    let agent2_info = agents.iter().find(|a| a.account_id == agent2).unwrap();
    assert!(!agent2_info.measurements_are_approved);
    assert!(agent2_info.ppid_is_approved);
}

// Test that get_agent returns correct agent information (None when not registered, Some when registered)
#[test]
fn test_get_agent() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    // Agent not whitelisted / not registered
    assert!(contract.get_agent(agent.clone()).is_none());

    // Whitelist agent but don't register
    contract.whitelist_agent_for_local(agent.clone());
    assert!(contract.get_agent(agent.clone()).is_none());

    // Register agent
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    contract.register_agent(DstackAttestation::default());

    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert_eq!(agent_info.account_id, agent);
    assert!(agent_info.measurements_are_approved);
    assert!(agent_info.ppid_is_approved);
}

// Test that request_signature fails if the agent is not whitelisted for local
#[test]
#[should_panic(expected = "Agent needs to be whitelisted for local mode")]
fn test_request_signature_not_whitelisted() {
    let mut contract = setup_contract();
    let agent = accounts(2);
    let context = get_context(agent, false);
    testing_env!(context.build());

    let _ = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "Ecdsa".to_string(),
    );
}

// Test that request_signature fails if the agent is whitelisted but not registered
#[test]
#[should_panic(expected = "Agent not registered")]
fn test_request_signature_not_registered() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    let context = get_context(agent, false);
    testing_env!(context.build());
    let _ = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "Ecdsa".to_string(),
    );
}

// Test that request_signature fails if the agent's measurements are removed from the approved list
#[test]
#[should_panic(expected = "Agent not registered with approved measurements")]
fn test_request_signature_measurements_removed() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    contract.register_agent(DstackAttestation::default());

    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    let _promise = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "Ecdsa".to_string(),
    );

    // Remove default measurements from approved list
    let context = get_context(accounts(0), false);
    testing_env!(context.build());
    contract.remove_measurements(FullMeasurementsHex::default());

    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(!agent_info.measurements_are_approved);

    let context = get_context(agent, false);
    testing_env!(context.build());
    let _ = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "Ecdsa".to_string(),
    );
}

// Test that request_signature fails if the agent's PPID is removed from the approved list
#[test]
#[should_panic(expected = "Agent not registered with approved PPID")]
fn test_request_signature_ppid_removed() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    contract.register_agent(DstackAttestation::default());

    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    let _promise = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "Ecdsa".to_string(),
    );

    // Remove default PPID from approved list
    let context = get_context(accounts(0), false);
    testing_env!(context.build());
    contract.remove_ppids(vec![Ppid::default()]);

    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(!agent_info.ppid_is_approved);

    let context = get_context(agent, false);
    testing_env!(context.build());
    let _ = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "Ecdsa".to_string(),
    );
}

// Test that request_signature succeeds when agent is whitelisted, registered, and measurements/PPID approved (Ecdsa)
#[test]
fn test_request_signature_success() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    contract.register_agent(DstackAttestation::default());

    let context = get_context(agent, false);
    testing_env!(context.build());
    let _promise = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "Ecdsa".to_string(),
    );
}

// Test that request_signature succeeds with Eddsa key type
#[test]
fn test_request_signature_with_eddsa() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    contract.register_agent(DstackAttestation::default());

    let context = get_context(agent, false);
    testing_env!(context.build());
    let _promise = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "Eddsa".to_string(),
    );
}

// Test that request_signature panics when key_type is not exactly "Ecdsa" or "Eddsa"
#[test]
#[should_panic(expected = "Invalid key type")]
fn test_request_signature_invalid_key_type() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent_for_local(agent.clone());

    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    contract.register_agent(DstackAttestation::default());

    let context = get_context(agent, false);
    testing_env!(context.build());
    let _ = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "invalid".to_string(),
    );
}
