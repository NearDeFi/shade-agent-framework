#[path = "helpers/mod.rs"]
mod helpers;

use helpers::*;
use near_api::Data;
use serde_json::json;
use tokio::time::{sleep, Duration};

/// Tests the complete agent lifecycle: whitelist → approve codehash → register → request signature
/// Also verifies view calls reflect state changes correctly
#[tokio::test]
async fn test_agent_full_lifecycle_with_state_persistence() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;

    // Deploy contract
    let contract_id = deploy_contract_default(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
    )
    .await?;

    sleep(Duration::from_millis(300)).await;

    // Create agent account
    let (agent_id, agent_signer) = create_user_account(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "agent",
    )
    .await?;

    // Step 1: Whitelist agent
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

    sleep(Duration::from_millis(200)).await;

    // Verify agent is whitelisted but not registered
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
    let agent = agent_info.data.unwrap();
    assert_eq!(agent["account_id"], agent_id.to_string());
    assert_eq!(agent["whitelisted"], true);
    assert_eq!(agent["registered"], false);
    assert_eq!(agent["codehash"], serde_json::Value::Null);
    assert_eq!(agent["codehash_is_approved"], false);

    // Step 2: Approve codehash
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

    sleep(Duration::from_millis(200)).await;

    // Verify codehash is approved
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

    assert!(approved_codehashes.data.contains(&codehash));

    // Step 3: Register agent
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

    // Verify agent is registered
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
    assert_eq!(agent["registered"], true);
    assert_eq!(agent["codehash"], codehash);
    assert_eq!(agent["codehash_is_approved"], true);

    // Step 4: Request signature (this will create a Promise, but we can't verify execution in sandbox)
    // The fact that it doesn't panic means the validation passed
    call_transaction(
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
    .await?;

    println!("✅ Agent full lifecycle test passed!");

    Ok(())
}

/// Tests contract initialization with real deployment
#[tokio::test]
async fn test_contract_initialization_state_real_deployment() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    println!("🔍 [DEBUG] Starting contract initialization test");
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

    // Verify get_requires_tee returns correct value
    println!("🔍 [DEBUG] Checking get_requires_tee");
    let requires_tee: Data<bool> = call_view(
        &contract_id,
        "get_requires_tee",
        json!({}),
        &network_config,
    )
    .await?;

    println!("🔍 [DEBUG] requires_tee value: {}", requires_tee.data);
    assert_eq!(requires_tee.data, false);

    // Verify initial state: no approved codehashes
    println!("🔍 [DEBUG] Checking initial approved codehashes");
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

    println!("🔍 [DEBUG] Approved codehashes count: {}", approved_codehashes.data.len());
    assert_eq!(approved_codehashes.data.len(), 0);

    // Verify initial state: no agents
    println!("🔍 [DEBUG] Checking initial agents");
    let agents: Data<Vec<serde_json::Value>> = call_view(
        &contract_id,
        "get_agents",
        json!({
            "from_index": null,
            "limit": null
        }),
        &network_config,
    )
    .await?;

    println!("🔍 [DEBUG] Agents count: {}", agents.data.len());
    assert_eq!(agents.data.len(), 0);

    // Verify owner can perform operations
    println!("🔍 [DEBUG] Testing owner can approve codehash");
    call_transaction(
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
    .await?;
    println!("🔍 [DEBUG] ✅ approve_codehash succeeded");

    println!("✅ Contract initialization test passed!");

    Ok(())
}
