use crate::*;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::testing_env;

// Only testing requires_tee = false since we cannot produce a valid attestation for a TEE in unit tests
// Lets try to separate logic of valid tee verification and codehash parsing so we can test codehash parsing without valid TEE attestation
// and not just autoset to "not-in-a-tee" if requires_tee is false in register_agent function

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

// Helper function to initialize contract
fn setup_contract() -> Contract {
    let owner = accounts(0);
    let mpc_contract = accounts(1);
    let context = get_context(owner.clone(), false);
    testing_env!(context.build());
    Contract::new(owner, mpc_contract, false)
}

// Test contract initialization with correct owner, MPC contract, and empty collections
#[test]
fn test_new() {
    let owner = accounts(0);
    let mpc_contract = accounts(1);
    let context = get_context(owner.clone(), false);
    testing_env!(context.build());

    let contract = Contract::new(owner.clone(), mpc_contract.clone(), false);

    assert_eq!(contract.owner_id, owner);
    assert_eq!(contract.mpc_contract_id, mpc_contract);
    assert_eq!(contract.requires_tee, false);
    assert_eq!(contract.get_approved_codehashes(&None, &None).len(), 0);
    assert_eq!(contract.get_agents(&None, &None).len(), 0);
}

// Test that owner can approve a codehash and it appears in the approved list
#[test]
fn test_approve_codehash() {
    let mut contract = setup_contract();

    let codehash = "test_codehash_123".to_string();

    contract.approve_codehash(codehash.clone());

    assert!(contract
        .get_approved_codehashes(&None, &None)
        .contains(&codehash));
    assert_eq!(contract.get_approved_codehashes(&None, &None).len(), 1);
}

// Test that non-owner cannot approve a codehash
#[test]
#[should_panic(expected = "Caller is not the owner")]
fn test_approve_codehash_not_owner() {
    let mut contract = setup_contract();
    let non_owner = accounts(2);
    let context = get_context(non_owner, false);
    testing_env!(context.build());

    contract.approve_codehash("test_codehash".to_string());
}

// Test that owner can remove a codehash from the approved list
#[test]
fn test_remove_codehash() {
    let mut contract = setup_contract();

    let codehash = "test_codehash_123".to_string();
    contract.approve_codehash(codehash.clone());
    assert!(contract
        .get_approved_codehashes(&None, &None)
        .contains(&codehash));

    contract.remove_codehash(codehash.clone());
    assert!(!contract
        .get_approved_codehashes(&None, &None)
        .contains(&codehash));
}

// Test that non-owner cannot remove a codehash from the approved list
#[test]
#[should_panic(expected = "Caller is not the owner")]
fn test_remove_codehash_not_owner() {
    let mut contract = setup_contract();
    let non_owner = accounts(2);
    contract.approve_codehash("test_codehash".to_string());

    let context = get_context(non_owner, false);
    testing_env!(context.build());
    contract.remove_codehash("test_codehash".to_string());
}

// Test that owner can whitelist an agent and agent appears in the list as whitelisted but not registered
#[test]
fn test_whitelist_agent() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent(agent.clone());

    let agent_info = contract.get_agent(agent.clone());
    assert!(agent_info.is_some());
    let agent_info = agent_info.unwrap();
    assert_eq!(agent_info.account_id, agent);
    assert!(agent_info.whitelisted);
    assert!(!agent_info.registered);
    assert!(!agent_info.codehash_is_approved);
}

// Test that whitelisting an agent twice doesn't create duplicates
#[test]
fn test_whitelist_agent_twice() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent(agent.clone());
    contract.whitelist_agent(agent.clone()); // Should not panic

    let agents = contract.get_agents(&None, &None);
    assert_eq!(agents.len(), 1);
}

// Test that whitelisting an already registered agent doesn't unregister it
#[test]
fn test_whitelist_agent_after_registration() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    // Whitelist agent
    contract.whitelist_agent(agent.clone());

    // Approve codehash and register agent
    contract.approve_codehash("not-in-a-tee".to_string());
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    let attestation = Attestation {
        quote_hex: "".to_string(),
        collateral: "".to_string(),
        checksum: "".to_string(),
        tcb_info: "".to_string(),
    };
    contract.register_agent(attestation);

    // Verify agent is registered
    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(agent_info.registered);
    assert_eq!(agent_info.codehash, Some("not-in-a-tee".to_string()));
    assert!(agent_info.codehash_is_approved);

    // Whitelist agent again (should not unregister)
    let context = get_context(accounts(0), false);
    testing_env!(context.build());
    contract.whitelist_agent(agent.clone());

    // Verify agent is still registered
    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(agent_info.registered);
    assert_eq!(agent_info.codehash, Some("not-in-a-tee".to_string()));
    assert!(agent_info.codehash_is_approved);
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

    contract.whitelist_agent(agent);
}

// Test that owner can remove an agent from the whitelist
#[test]
fn test_remove_agent() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    contract.whitelist_agent(agent.clone());
    assert!(contract.get_agent(agent.clone()).is_some());

    contract.remove_agent(agent.clone());
    assert!(contract.get_agent(agent).is_none());
}

// Test that non-owner cannot remove an agent from the whitelist
#[test]
#[should_panic(expected = "Caller is not the owner")]
fn test_remove_agent_not_owner() {
    let mut contract = setup_contract();
    let non_owner = accounts(2);
    let agent = accounts(3);
    contract.whitelist_agent(agent.clone());

    let context = get_context(non_owner, false);
    testing_env!(context.build());
    contract.remove_agent(agent);
}

// Test that a whitelisted agent can register
#[test]
fn test_register_agent_without_tee() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    // First, owner whitelists the agent and approves the codehash
    contract.whitelist_agent(agent.clone());
    contract.approve_codehash("not-in-a-tee".to_string());

    // Then, agent registers
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());

    let attestation = Attestation {
        quote_hex: "".to_string(),
        collateral: "".to_string(),
        checksum: "".to_string(),
        tcb_info: "".to_string(),
    };

    let result = contract.register_agent(attestation);
    assert!(result);

    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(agent_info.registered);
    assert_eq!(agent_info.codehash, Some("not-in-a-tee".to_string()));
    assert!(agent_info.codehash_is_approved);
}

// Test that an agent can register twice and the registration is updated
#[test]
fn test_register_agent_twice() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    // Whitelist agent and approve codehash
    contract.whitelist_agent(agent.clone());
    contract.approve_codehash("not-in-a-tee".to_string());

    // Register agent first time
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    let attestation = Attestation {
        quote_hex: "".to_string(),
        collateral: "".to_string(),
        checksum: "".to_string(),
        tcb_info: "".to_string(),
    };
    let result = contract.register_agent(attestation);
    assert!(result);

    // Verify agent is registered
    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(agent_info.registered);
    assert_eq!(agent_info.codehash, Some("not-in-a-tee".to_string()));
    assert!(agent_info.codehash_is_approved);

    // Register agent again
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    let attestation2 = Attestation {
        quote_hex: "".to_string(),
        collateral: "".to_string(),
        checksum: "".to_string(),
        tcb_info: "".to_string(),
    };
    let result = contract.register_agent(attestation2);
    assert!(result);

    // Verify agent is still registered
    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(agent_info.registered);
    assert_eq!(agent_info.codehash, Some("not-in-a-tee".to_string()));
    assert!(agent_info.codehash_is_approved);
}

// Test that an agent cannot register if not whitelisted
#[test]
#[should_panic(expected = "Agent needs to be whitelisted first")]
fn test_register_agent_not_whitelisted() {
    let mut contract = setup_contract();
    let agent = accounts(2);
    let context = get_context(agent, false);
    testing_env!(context.build());

    let attestation = Attestation {
        quote_hex: "".to_string(),
        collateral: "".to_string(),
        checksum: "".to_string(),
        tcb_info: "".to_string(),
    };

    contract.register_agent(attestation);
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

// Test that get_approved_codehashes returns all approved codehashes and pagination works correctly
#[test]
fn test_get_approved_codehashes() {
    let mut contract = setup_contract();

    contract.approve_codehash("hash1".to_string());
    contract.approve_codehash("hash2".to_string());
    contract.approve_codehash("hash3".to_string());

    let all_hashes = contract.get_approved_codehashes(&None, &None);
    assert_eq!(all_hashes.len(), 3);
    assert!(all_hashes.contains(&"hash1".to_string()));
    assert!(all_hashes.contains(&"hash2".to_string()));
    assert!(all_hashes.contains(&"hash3".to_string()));

    // Test pagination
    let first_two = contract.get_approved_codehashes(&Some(0), &Some(2));
    assert_eq!(first_two.len(), 2);

    let from_index = contract.get_approved_codehashes(&Some(1), &Some(2));
    assert_eq!(from_index.len(), 2);
}

// Test that get_agents returns all whitelisted agents with correct details and pagination works
#[test]
fn test_get_agents() {
    let mut contract = setup_contract();
    let agent1 = accounts(2);
    let agent2 = accounts(3);

    contract.whitelist_agent(agent1.clone());
    contract.whitelist_agent(agent2.clone());

    let agents = contract.get_agents(&None, &None);
    assert_eq!(agents.len(), 2);

    // Verify agent details
    let agent1_info = agents.iter().find(|a| a.account_id == agent1).unwrap();
    assert!(agent1_info.whitelisted);
    assert!(!agent1_info.registered);
    assert!(!agent1_info.codehash_is_approved);

    // Test pagination
    let first_agent = contract.get_agents(&Some(0), &Some(1));
    assert_eq!(first_agent.len(), 1);
}

// Test that get_agents correctly returns codehash_is_approved for multiple agents with different states
#[test]
fn test_get_agents_codehash_approval_states() {
    let mut contract = setup_contract();
    let agent1 = accounts(2);
    let agent2 = accounts(3);
    let agent3 = accounts(4);

    // Whitelist all agents
    contract.whitelist_agent(agent1.clone());
    contract.whitelist_agent(agent2.clone());
    contract.whitelist_agent(agent3.clone());

    // Approve codehash (in non-TEE mode, all agents use "not-in-a-tee")
    contract.approve_codehash("not-in-a-tee".to_string());

    // Register agent1
    let context = get_context(agent1.clone(), false);
    testing_env!(context.build());
    let attestation1 = Attestation {
        quote_hex: "".to_string(),
        collateral: "".to_string(),
        checksum: "".to_string(),
        tcb_info: "".to_string(),
    };
    contract.register_agent(attestation1);

    // Register agent2
    let context = get_context(agent2.clone(), false);
    testing_env!(context.build());
    let attestation2 = Attestation {
        quote_hex: "".to_string(),
        collateral: "".to_string(),
        checksum: "".to_string(),
        tcb_info: "".to_string(),
    };
    contract.register_agent(attestation2);

    // agent3 remains unregistered

    // Get all agents and verify codehash_is_approved
    let agents = contract.get_agents(&None, &None);
    assert_eq!(agents.len(), 3);

    let agent1_info = agents.iter().find(|a| a.account_id == agent1).unwrap();
    assert!(agent1_info.registered);
    assert_eq!(agent1_info.codehash, Some("not-in-a-tee".to_string()));
    assert!(agent1_info.codehash_is_approved);

    let agent2_info = agents.iter().find(|a| a.account_id == agent2).unwrap();
    assert!(agent2_info.registered);
    assert_eq!(agent2_info.codehash, Some("not-in-a-tee".to_string()));
    assert!(agent2_info.codehash_is_approved);

    let agent3_info = agents.iter().find(|a| a.account_id == agent3).unwrap();
    assert!(!agent3_info.registered);
    assert_eq!(agent3_info.codehash, None);
    assert!(!agent3_info.codehash_is_approved);

    // Remove the codehash from approved list
    let context = get_context(accounts(0), false);
    testing_env!(context.build());
    contract.remove_codehash("not-in-a-tee".to_string());

    // Get agents again and verify both registered agents' codehash_is_approved is now false
    let agents = contract.get_agents(&None, &None);
    let agent1_info = agents.iter().find(|a| a.account_id == agent1).unwrap();
    assert!(agent1_info.registered);
    assert_eq!(agent1_info.codehash, Some("not-in-a-tee".to_string()));
    assert!(!agent1_info.codehash_is_approved);

    let agent2_info = agents.iter().find(|a| a.account_id == agent2).unwrap();
    assert!(agent2_info.registered);
    assert_eq!(agent2_info.codehash, Some("not-in-a-tee".to_string()));
    assert!(!agent2_info.codehash_is_approved);

    // agent3 should still be unregistered
    let agent3_info = agents.iter().find(|a| a.account_id == agent3).unwrap();
    assert!(!agent3_info.registered);
    assert!(!agent3_info.codehash_is_approved);
}

// Test that get_agent returns correct agent information for different states (not whitelisted, whitelisted, registered)
#[test]
fn test_get_agent() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    // Agent not whitelisted
    assert!(contract.get_agent(agent.clone()).is_none());

    // Whitelist agent
    contract.whitelist_agent(agent.clone());
    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert_eq!(agent_info.account_id, agent);
    assert!(agent_info.whitelisted);
    assert!(!agent_info.registered);
    assert_eq!(agent_info.codehash, None);
    assert!(!agent_info.codehash_is_approved);

    // Approve the codehash
    contract.approve_codehash("not-in-a-tee".to_string());

    // Register agent
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    let attestation = Attestation {
        quote_hex: "".to_string(),
        collateral: "".to_string(),
        checksum: "".to_string(),
        tcb_info: "".to_string(),
    };
    contract.register_agent(attestation);

    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(agent_info.registered);
    assert_eq!(agent_info.codehash, Some("not-in-a-tee".to_string()));
    assert!(agent_info.codehash_is_approved);
}

// Test that request_signature fails if the agent is not whitelisted
#[test]
#[should_panic(expected = "Agent not whitelisted")]
fn test_request_signature_not_whitelisted() {
    let mut contract = setup_contract();
    let agent = accounts(2);
    let context = get_context(agent, false);
    testing_env!(context.build());

    // Try to request signature without being whitelisted
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

    // Whitelist but don't register
    contract.whitelist_agent(agent.clone());

    // Try to request signature without being registered
    let context = get_context(agent, false);
    testing_env!(context.build());
    let _ = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "Ecdsa".to_string(),
    );
}

// Test that request_signature fails if the agent's codehash is removed from the approved list
#[test]
#[should_panic(expected = "Agent not registered with approved codehash")]
fn test_request_signature_codehash_removed() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    // Whitelist agent and approve codehash
    contract.whitelist_agent(agent.clone());
    contract.approve_codehash("not-in-a-tee".to_string());

    // Register agent
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    let attestation = Attestation {
        quote_hex: "".to_string(),
        collateral: "".to_string(),
        checksum: "".to_string(),
        tcb_info: "".to_string(),
    };
    contract.register_agent(attestation);

    // Verify agent can request signature initially
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    let _promise = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "Ecdsa".to_string(),
    );

    // Remove the codehash from approved list
    let context = get_context(accounts(0), false);
    testing_env!(context.build());
    contract.remove_codehash("not-in-a-tee".to_string());

    // Verify codehash_is_approved is now false
    let agent_info = contract.get_agent(agent.clone()).unwrap();
    assert!(agent_info.registered);
    assert_eq!(agent_info.codehash, Some("not-in-a-tee".to_string()));
    assert!(!agent_info.codehash_is_approved);

    // Now try to request signature - should fail because codehash is no longer approved
    let context = get_context(agent, false);
    testing_env!(context.build());
    let _ = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "Ecdsa".to_string(),
    );
}

// Test that request_signature succeeds when agent is whitelisted, registered, and codehash is approved (Ecdsa key type)
#[test]
fn test_request_signature_success() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    // Whitelist agent and approve the "not-in-a-tee" codehash
    contract.whitelist_agent(agent.clone());
    contract.approve_codehash("not-in-a-tee".to_string());

    // Register agent
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    let attestation = Attestation {
        quote_hex: "".to_string(),
        collateral: "".to_string(),
        checksum: "".to_string(),
        tcb_info: "".to_string(),
    };
    contract.register_agent(attestation);

    // Now request signature should succeed (Promise will be created, but won't execute in unit tests)
    let context = get_context(agent, false);
    testing_env!(context.build());
    let _promise = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "Ecdsa".to_string(),
    );
    // Promise is created successfully - validation passed
}

// Test that request_signature succeeds when agent is whitelisted, registered, and codehash is approved (Eddsa key type)
#[test]
fn test_request_signature_with_eddsa() {
    let mut contract = setup_contract();
    let agent = accounts(2);

    // Whitelist agent and approve the "not-in-a-tee" codehash
    contract.whitelist_agent(agent.clone());
    contract.approve_codehash("not-in-a-tee".to_string());

    // Register agent
    let context = get_context(agent.clone(), false);
    testing_env!(context.build());
    let attestation = Attestation {
        quote_hex: "".to_string(),
        collateral: "".to_string(),
        checksum: "".to_string(),
        tcb_info: "".to_string(),
    };
    contract.register_agent(attestation);

    // Test with Eddsa key type
    let context = get_context(agent, false);
    testing_env!(context.build());
    let _promise = contract.request_signature(
        "path".to_string(),
        "payload".to_string(),
        "Eddsa".to_string(),
    );
    // Promise is created successfully
}
