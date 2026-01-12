#[path = "helpers/mod.rs"]
mod helpers;

use helpers::*;
use near_api::Data;
use serde_json::json;
use tokio::time::{sleep, Duration};

/// Tests owner transfer and new owner operations
#[tokio::test]
async fn test_owner_transfer_and_new_owner_operations() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    println!("🔍 [DEBUG] Starting owner transfer test");
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;
    println!("🔍 [DEBUG] Genesis account: {}", genesis_account_id);

    let contract_id = deploy_contract_default(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
    )
    .await?;
    println!("🔍 [DEBUG] Contract deployed: {}", contract_id);

    sleep(Duration::from_millis(200)).await;

    // Create new owner account
    let (new_owner_id, new_owner_signer) = create_user_account(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "new_owner",
    )
    .await?;
    println!("🔍 [DEBUG] New owner account created: {}", new_owner_id);

    // Transfer ownership
    println!("🔍 [DEBUG] Transferring ownership from {} to {}", genesis_account_id, new_owner_id);
    call_transaction(
        &contract_id,
        "update_owner_id",
        json!({
            "owner_id": new_owner_id
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?;
    println!("🔍 [DEBUG] Ownership transfer transaction completed");

    sleep(Duration::from_millis(500)).await;

    // Verify old owner cannot approve codehash
    println!("🔍 [DEBUG] Attempting to approve codehash with old owner ({})", genesis_account_id);
    let result = call_transaction(
        &contract_id,
        "approve_codehash",
        json!({
            "codehash": "test_hash"
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await;

    println!("🔍 [DEBUG] Old owner approve_codehash result: is_ok={:?}", result.is_ok());
    if let Err(e) = &result {
        println!("🔍 [DEBUG] Error details: {:?}", e);
    }

    if result.is_ok() {
        // If it succeeded, check if codehash was actually added (this would be a security issue)
        println!("🔍 [DEBUG] ⚠️  Old owner transaction succeeded! Checking if codehash was added...");
        sleep(Duration::from_millis(200)).await;
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
        
        println!("🔍 [DEBUG] Approved codehashes after old owner attempt: {:?}", approved_codehashes.data);
        
        if approved_codehashes.data.contains(&"test_hash".to_string()) {
            panic!("❌ Old owner should not be able to approve codehash, but codehash was approved");
        }
        // If transaction succeeded but codehash wasn't added, that's fine - contract rejected it internally
        println!("🔍 [DEBUG] ✅ Transaction succeeded but codehash was not added (contract correctly rejected)");
    } else {
        // Transaction failed as expected
        println!("🔍 [DEBUG] ✅ Old owner correctly rejected");
    }
    println!("🔍 [DEBUG] ✅ Old owner correctly rejected");

    // Verify new owner can approve codehash
    println!("🔍 [DEBUG] Attempting to approve codehash with new owner ({})", new_owner_id);
    call_transaction(
        &contract_id,
        "approve_codehash",
        json!({
            "codehash": "test_hash"
        }),
        &new_owner_id,
        &new_owner_signer,
        &network_config,
        None,
    )
    .await?;

    sleep(Duration::from_millis(200)).await;

    // Verify codehash was approved
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

    assert!(approved_codehashes.data.contains(&"test_hash".to_string()));

    // Verify new owner can whitelist agents
    let (agent_id, _) = create_user_account(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "agent",
    )
    .await?;

    call_transaction(
        &contract_id,
        "whitelist_agent",
        json!({
            "account_id": agent_id
        }),
        &new_owner_id,
        &new_owner_signer,
        &network_config,
        None,
    )
    .await?;

    sleep(Duration::from_millis(200)).await;

    // Verify agent was whitelisted
    let agent_info: Data<Option<serde_json::Value>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent_id
        }),
        &network_config,
    )
    .await?;

    assert!(agent_info.data.is_some(), "Agent should be whitelisted");

    println!("✅ Owner transfer test passed!");

    Ok(())
}
