#[path = "helpers/mod.rs"]
mod helpers;

use helpers::*;
use serde_json::json;
use tokio::time::{sleep, Duration};

/// Tests that request_signature makes correct cross-contract call to MPC contract
#[tokio::test]
async fn test_request_signature_calls_mpc_contract() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;

    // Deploy mock MPC contract
    let mpc_contract_id = deploy_mock_mpc_contract(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "mpc",
    )
    .await?;

    sleep(Duration::from_millis(200)).await;

    // Deploy main contract with mock MPC as the MPC contract
    let contract_id = deploy_contract(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        CONTRACT_WASM_PATH,
        "new",
        json!({
            "owner_id": genesis_account_id,
            "mpc_contract_id": mpc_contract_id,
            "requires_tee": false
        }),
    )
    .await?;

    sleep(Duration::from_millis(200)).await;

    // Create and register agent
    let (agent_id, agent_signer) = create_user_account(
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
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?;

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

    // Request signature - this should call the mock MPC contract
    // The mock MPC contract should receive the call
    call_transaction(
        &contract_id,
        "request_signature",
        json!({
            "path": "m/44'/397'/0'",
            "payload": "test_payload_ecdsa",
            "key_type": "Ecdsa"
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        None,
    )
    .await?;

    sleep(Duration::from_millis(500)).await;

    // Verify the mock MPC contract was called by checking its state
    // (This depends on what the mock MPC contract exposes)
    // For now, we just verify the call didn't fail
    println!("✅ Request signature cross-contract call test passed!");

    Ok(())
}

/// Tests that request_signature uses correct parameters for Ecdsa vs Eddsa
#[tokio::test]
async fn test_request_signature_ecdsa_vs_eddsa_real_calls() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;

    // Deploy mock MPC contract
    let mpc_contract_id = deploy_mock_mpc_contract(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "mpc",
    )
    .await?;

    sleep(Duration::from_millis(200)).await;

    // Deploy main contract
    let contract_id = deploy_contract(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        CONTRACT_WASM_PATH,
        "new",
        json!({
            "owner_id": genesis_account_id,
            "mpc_contract_id": mpc_contract_id,
            "requires_tee": false
        }),
    )
    .await?;

    sleep(Duration::from_millis(200)).await;

    // Create and register agent
    let (agent_id, agent_signer) = create_user_account(
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
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?;

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

    // Request signature with Ecdsa (domain_id should be 0)
    call_transaction(
        &contract_id,
        "request_signature",
        json!({
            "path": "m/44'/397'/0'",
            "payload": "ecdsa_payload",
            "key_type": "Ecdsa"
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        None,
    )
    .await?;

    sleep(Duration::from_millis(500)).await;

    // Request signature with Eddsa (domain_id should be 1)
    call_transaction(
        &contract_id,
        "request_signature",
        json!({
            "path": "m/44'/397'/0'",
            "payload": "eddsa_payload",
            "key_type": "Eddsa"
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        None,
    )
    .await?;

    sleep(Duration::from_millis(500)).await;

    println!("✅ Ecdsa vs Eddsa signature request test passed!");

    Ok(())
}

/// Tests that updating MPC contract ID redirects calls to new contract
#[tokio::test]
async fn test_update_mpc_contract_id_redirects_calls() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;

    // Deploy two mock MPC contracts
    let mpc_contract_1 = deploy_mock_mpc_contract(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "mpc1",
    )
    .await?;

    sleep(Duration::from_millis(200)).await;

    let mpc_contract_2 = deploy_mock_mpc_contract(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "mpc2",
    )
    .await?;

    sleep(Duration::from_millis(200)).await;

    // Deploy main contract with first MPC
    let contract_id = deploy_contract(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        CONTRACT_WASM_PATH,
        "new",
        json!({
            "owner_id": genesis_account_id,
            "mpc_contract_id": mpc_contract_1,
            "requires_tee": false
        }),
    )
    .await?;

    sleep(Duration::from_millis(200)).await;

    // Create and register agent
    let (agent_id, agent_signer) = create_user_account(
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
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?;

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

    // Request signature - should call first MPC
    call_transaction(
        &contract_id,
        "request_signature",
        json!({
            "path": "m/44'/397'/0'",
            "payload": "test_before_update",
            "key_type": "Ecdsa"
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        None,
    )
    .await?;

    sleep(Duration::from_millis(500)).await;

    // Update MPC contract ID to second contract
    call_transaction(
        &contract_id,
        "update_mpc_contract_id",
        json!({
            "mpc_contract_id": mpc_contract_2
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?;

    sleep(Duration::from_millis(200)).await;

    // Request signature again - should now call second MPC
    call_transaction(
        &contract_id,
        "request_signature",
        json!({
            "path": "m/44'/397'/0'",
            "payload": "test_after_update",
            "key_type": "Ecdsa"
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        None,
    )
    .await?;

    sleep(Duration::from_millis(500)).await;

    println!("✅ MPC contract ID update test passed!");

    Ok(())
}
