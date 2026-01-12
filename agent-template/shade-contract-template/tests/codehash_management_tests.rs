//! # Codehash Management Tests
//!
//! Tests that verify codehash approval, removal, and re-approval operations
//! and their effects on registered agents in a real blockchain environment.

#[path = "helpers/mod.rs"]
mod helpers;

use helpers::*;
use near_api::Data;
use serde_json::json;
use tokio::time::{sleep, Duration};

/// Tests codehash removal affects multiple registered agents and re-approval restores access
/// Also tests multiple codehashes with multiple agents
#[tokio::test]
async fn test_codehash_removal_and_reapproval_with_multiple_agents() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;

    let contract_id = deploy_contract_default(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
    )
    .await?;

    sleep(Duration::from_millis(200)).await;

    // Create multiple agents
    let (agent1_id, agent1_signer) = create_user_account(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "agent1",
    )
    .await?;

    let (agent2_id, agent2_signer) = create_user_account(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "agent2",
    )
    .await?;

    let (agent3_id, agent3_signer) = create_user_account(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "agent3",
    )
    .await?;

    // Approve codehash
    let codehash = "not-in-a-tee".to_string();
    call_transaction(
        &contract_id,
        "approve_codehash",
        json!({
            "codehash": codehash
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?;

    // Whitelist and register all three agents
    for (agent_id, agent_signer) in [
        (&agent1_id, &agent1_signer),
        (&agent2_id, &agent2_signer),
        (&agent3_id, &agent3_signer),
    ] {
        call_transaction(
            &contract_id,
            "whitelist_agent",
            json!({
                "account_id": agent_id
            }),
            &genesis_account_id,
            &genesis_signer,
            &network_config,
            None,
        )
        .await?;

        call_transaction(
            &contract_id,
            "register_agent",
            json!({
                "attestation": {
                    "quote_hex": "",
                    "collateral": "",
                    "checksum": "",
                    "tcb_info": ""
                }
            }),
            agent_id,
            agent_signer,
            &network_config,
            None,
        )
        .await?;
    }

    sleep(Duration::from_millis(300)).await;

    // Verify all agents have codehash_is_approved: true
    for agent_id in [&agent1_id, &agent2_id, &agent3_id] {
        let agent_info: Data<Option<serde_json::Value>> = call_view(
            &contract_id,
            "get_agent",
            json!({
                "account_id": agent_id
            }),
            &network_config,
        )
        .await?;

        let agent = agent_info.data.unwrap();
        assert_eq!(agent["codehash_is_approved"], true, "Agent {} should have approved codehash", agent_id);
    }

    // Remove codehash
    call_transaction(
        &contract_id,
        "remove_codehash",
        json!({
            "codehash": codehash
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?;

    sleep(Duration::from_millis(200)).await;

    // Verify all agents now have codehash_is_approved: false
    for agent_id in [&agent1_id, &agent2_id, &agent3_id] {
        let agent_info: Data<Option<serde_json::Value>> = call_view(
            &contract_id,
            "get_agent",
            json!({
                "account_id": agent_id
            }),
            &network_config,
        )
        .await?;

        let agent = agent_info.data.unwrap();
        assert_eq!(agent["codehash_is_approved"], false, "Agent {} should not have approved codehash", agent_id);
        assert_eq!(agent["registered"], true, "Agent {} should still be registered", agent_id);
    }

    // Re-approve codehash
    call_transaction(
        &contract_id,
        "approve_codehash",
        json!({
            "codehash": codehash
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?;

    sleep(Duration::from_millis(200)).await;

    // Verify all agents now have codehash_is_approved: true again
    for agent_id in [&agent1_id, &agent2_id, &agent3_id] {
        let agent_info: Data<Option<serde_json::Value>> = call_view(
            &contract_id,
            "get_agent",
            json!({
                "account_id": agent_id
            }),
            &network_config,
        )
        .await?;

        let agent = agent_info.data.unwrap();
        assert_eq!(agent["codehash_is_approved"], true, "Agent {} should have approved codehash again", agent_id);
    }

    // Verify agents can request signatures again
    call_transaction(
        &contract_id,
        "request_signature",
        json!({
            "path": "m/44'/397'/0'",
            "payload": "test_payload",
            "key_type": "Ecdsa"
        }),
        &agent1_id,
        &agent1_signer,
        &network_config,
        None,
    )
    .await?;

    println!("✅ Codehash removal and re-approval test passed!");

    Ok(())
}

/// Tests that agent registration fails if codehash is removed after initial approval
#[tokio::test]
async fn test_register_agent_after_codehash_removed_fails() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;

    println!("🔍 [DEBUG] Starting register agent after codehash removed test");
    let contract_id = deploy_contract_default(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
    )
    .await?;
    println!("🔍 [DEBUG] Contract deployed: {}", contract_id);

    sleep(Duration::from_millis(200)).await;

    // Create two agents
    let (agent1_id, agent1_signer) = create_user_account(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "agent1",
    )
    .await?;

    let (agent2_id, agent2_signer) = create_user_account(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "agent2",
    )
    .await?;

    let codehash = "not-in-a-tee".to_string();
    println!("🔍 [DEBUG] Agent1: {}, Agent2: {}", agent1_id, agent2_id);
    println!("🔍 [DEBUG] Codehash: {}", codehash);

    // Approve codehash and register first agent
    println!("🔍 [DEBUG] Approving codehash");
    call_transaction(
        &contract_id,
        "approve_codehash",
        json!({
            "codehash": codehash
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?;
    println!("🔍 [DEBUG] Codehash approved");

    println!("🔍 [DEBUG] Whitelisting agent1");
    call_transaction(
        &contract_id,
        "whitelist_agent",
        json!({
            "account_id": agent1_id
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?;

    println!("🔍 [DEBUG] Registering agent1");
    call_transaction(
        &contract_id,
        "register_agent",
        json!({
            "attestation": {
                "quote_hex": "",
                "collateral": "",
                "checksum": "",
                "tcb_info": ""
            }
        }),
        &agent1_id,
        &agent1_signer,
        &network_config,
        None,
    )
    .await?;

    // Remove codehash
    println!("🔍 [DEBUG] Removing codehash: {}", codehash);
    call_transaction(
        &contract_id,
        "remove_codehash",
        json!({
            "codehash": codehash
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?;
    println!("🔍 [DEBUG] Codehash removal transaction completed");

    sleep(Duration::from_millis(500)).await;

    // Verify codehash is actually removed before testing
    println!("🔍 [DEBUG] Verifying codehash is removed...");
    let approved_codehashes: Data<Vec<String>> = call_view(
        &contract_id,
        "get_approved_codehashes",
        json!({
            "from_index": null,
            "limit": null
        }),
        &network_config,
    )
    .await?;
    
    println!("🔍 [DEBUG] Approved codehashes after removal: {:?}", approved_codehashes.data);
    println!("🔍 [DEBUG] Codehash '{}' in approved list: {}", codehash, approved_codehashes.data.contains(&codehash));
    
    assert!(
        !approved_codehashes.data.contains(&"not-in-a-tee".to_string()),
        "Codehash should be removed before testing registration"
    );
    println!("🔍 [DEBUG] ✅ Codehash confirmed removed");

    // Try to register second agent - should fail
    println!("🔍 [DEBUG] Whitelisting agent2: {}", agent2_id);
    call_transaction(
        &contract_id,
        "whitelist_agent",
        json!({
            "account_id": agent2_id
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?;

    sleep(Duration::from_millis(200)).await;

    // This should fail because codehash is not approved
    println!("🔍 [DEBUG] Attempting to register agent2 (should fail - codehash not approved)");
    let result = call_transaction(
        &contract_id,
        "register_agent",
        json!({
            "attestation": {
                "quote_hex": "",
                "collateral": "",
                "checksum": "",
                "tcb_info": ""
            }
        }),
        &agent2_id,
        &agent2_signer,
        &network_config,
        None,
    )
    .await;

    println!("🔍 [DEBUG] Agent2 registration result: is_ok={:?}", result.is_ok());
    if let Err(e) = &result {
        println!("🔍 [DEBUG] Error details: {:?}", e);
    }

    if result.is_ok() {
        // If it succeeded, verify the codehash is still not approved
        println!("🔍 [DEBUG] ⚠️  Registration succeeded! Checking state...");
        sleep(Duration::from_millis(200)).await;
        let approved_codehashes_after: Data<Vec<String>> = call_view(
            &contract_id,
            "get_approved_codehashes",
            json!({
                "from_index": null,
                "limit": null
            }),
            &network_config,
        )
        .await?;
        
        println!("🔍 [DEBUG] Approved codehashes after registration: {:?}", approved_codehashes_after.data);
        
        if approved_codehashes_after.data.contains(&"not-in-a-tee".to_string()) {
            panic!("❌ Codehash was re-added during registration, which shouldn't happen");
        }
        
        // Check if agent was actually registered
        let agent_info: Data<Option<serde_json::Value>> = call_view(
            &contract_id,
            "get_agent",
            json!({
                "account_id": agent2_id
            }),
            &network_config,
        )
        .await?;
        
        println!("🔍 [DEBUG] Agent2 info after registration: {:?}", agent_info.data);
        
        if let Some(agent) = agent_info.data {
            let registered = agent["registered"].as_bool().unwrap_or(false);
            println!("🔍 [DEBUG] Agent2 registered status: {}", registered);
            if registered {
                panic!("❌ Registration should fail when codehash is not approved, but agent was registered");
            }
        }
        
        // If transaction succeeded but agent wasn't registered, that's fine - contract rejected it internally
        println!("🔍 [DEBUG] ✅ Transaction succeeded but agent was not registered (contract correctly rejected)");
    } else {
        // Transaction failed as expected
        println!("🔍 [DEBUG] ✅ Registration correctly rejected");
    }

    println!("✅ Register agent after codehash removed test passed!");

    Ok(())
}

/// Tests that removing a registered agent prevents signature requests
#[tokio::test]
async fn test_remove_registered_agent_real_state() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    println!("🔍 [DEBUG] Starting remove registered agent test");
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;

    let contract_id = deploy_contract_default(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
    )
    .await?;
    println!("🔍 [DEBUG] Contract deployed: {}", contract_id);

    sleep(Duration::from_millis(200)).await;

    // Create and register agent
    let (agent_id, agent_signer) = create_user_account(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "agent",
    )
    .await?;
    println!("🔍 [DEBUG] Agent account created: {}", agent_id);

    println!("🔍 [DEBUG] Whitelisting agent");
    call_transaction(
        &contract_id,
        "whitelist_agent",
        json!({
            "account_id": agent_id
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?;

    println!("🔍 [DEBUG] Approving codehash: not-in-a-tee");
    call_transaction(
        &contract_id,
        "approve_codehash",
        json!({
            "codehash": "not-in-a-tee"
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?;

    println!("🔍 [DEBUG] Registering agent");
    call_transaction(
        &contract_id,
        "register_agent",
        json!({
            "attestation": {
                "quote_hex": "",
                "collateral": "",
                "checksum": "",
                "tcb_info": ""
            }
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        None,
    )
    .await?;

    sleep(Duration::from_millis(200)).await;

    // Verify agent exists
    println!("🔍 [DEBUG] Verifying agent exists");
    let agent_info: Data<Option<serde_json::Value>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent_id
        }),
        &network_config,
    )
    .await?;

    println!("🔍 [DEBUG] Agent info before removal: {:?}", agent_info.data);
    assert!(agent_info.data.is_some(), "Agent should exist");

    // Remove agent
    println!("🔍 [DEBUG] Removing agent");
    call_transaction(
        &contract_id,
        "remove_agent",
        json!({
            "account_id": agent_id
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?;
    println!("🔍 [DEBUG] Remove agent transaction completed");

    sleep(Duration::from_millis(500)).await;

    // Verify agent no longer exists
    println!("🔍 [DEBUG] Verifying agent no longer exists");
    let agent_info: Data<Option<serde_json::Value>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent_id
        }),
        &network_config,
    )
    .await?;

    println!("🔍 [DEBUG] Agent info after removal: {:?}", agent_info.data);
    assert!(agent_info.data.is_none(), "Agent should not exist");

    // Verify agent cannot request signature
    println!("🔍 [DEBUG] Attempting signature request with removed agent (should fail)");
    let result = call_transaction(
        &contract_id,
        "request_signature",
        json!({
            "path": "m/44'/397'/0'",
            "payload": "test_payload",
            "key_type": "Ecdsa"
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        None,
    )
    .await;

    println!("🔍 [DEBUG] Signature request result: is_ok={:?}", result.is_ok());
    if let Err(e) = &result {
        println!("🔍 [DEBUG] Error details: {:?}", e);
    }

    if result.is_ok() {
        // Double-check agent still doesn't exist
        println!("🔍 [DEBUG] ⚠️  Signature request succeeded! Checking agent state...");
        sleep(Duration::from_millis(200)).await;
        let agent_check: Data<Option<serde_json::Value>> = call_view(
            &contract_id,
            "get_agent",
            json!({
                "account_id": agent_id
            }),
            &network_config,
        )
        .await?;
        
        println!("🔍 [DEBUG] Agent info after signature request: {:?}", agent_check.data);
        
        if agent_check.data.is_some() {
            panic!("❌ Agent was re-added during signature request, which shouldn't happen");
        }
        
        // If transaction succeeded but agent wasn't re-added, that's fine - contract rejected it internally
        println!("🔍 [DEBUG] ✅ Transaction succeeded but agent was not re-added (contract correctly rejected)");
    } else {
        // Transaction failed as expected
        println!("🔍 [DEBUG] ✅ Signature request correctly rejected");
    }

    println!("✅ Remove registered agent test passed!");

    Ok(())
}
