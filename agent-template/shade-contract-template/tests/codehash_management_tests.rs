mod helpers;

use helpers::*;
use near_api::Data;
use serde_json::json;
use tokio::time::{sleep, Duration};

// Tests codehash lifecycle management with multiple agents:
// - Verifies that codehash removal affects all registered agents simultaneously (sets codehash_is_approved to false)
// - Ensures agents with removed codehash cannot request signatures
// - Confirms that re-approving a codehash restores access for remaining registered agents
// - Validates that removed agents cannot be re-registered even after codehash re-approval
// - Verifies that signature requests are re-enabled after codehash re-approval
#[tokio::test]
async fn test_codehash_management() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;

    let contract_id =
        deploy_contract_default(&network_config, &genesis_account_id, &genesis_signer).await?;

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
    let _ = call_transaction(
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
    .await?
    .assert_success();

    // Whitelist and register all three agents
    for (agent_id, agent_signer) in [
        (&agent1_id, &agent1_signer),
        (&agent2_id, &agent2_signer),
        (&agent3_id, &agent3_signer),
    ] {
        let _ = call_transaction(
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
        .await?
        .assert_success();

        let _ = call_transaction(
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
        .await?
        .assert_success();
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
        assert_eq!(
            agent["codehash_is_approved"], true,
            "Agent {} should have approved codehash",
            agent_id
        );
    }

    // Remove codehash
    let _ = call_transaction(
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
    .await?
    .assert_success();

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
        assert_eq!(
            agent["codehash_is_approved"], false,
            "Agent {} should not have approved codehash",
            agent_id
        );
        assert_eq!(
            agent["registered"], true,
            "Agent {} should still be registered",
            agent_id
        );
    }

    // Attempt to request a signature with a removed codehash
    let result = call_transaction(
        &contract_id,
        "request_signature",
        json!({
            "path": "path",
            "payload": "test_payload",
            "key_type": "Ecdsa"
        }),
        &agent1_id,
        &agent1_signer,
        &network_config,
        None,
    )
    .await?
    .into_result();

    // Assert that the transaction failed with "Agent not registered with approved codehash" error
    match result {
        Ok(_) => {
            panic!("Expected transaction to fail with 'Agent not registered with approved codehash', but it succeeded");
        }
        Err(e) => {
            let error_str = format!("{:?}", e);
            assert!(
                error_str.contains("Agent not registered with approved codehash"),
                "Expected 'Agent not registered with approved codehash' error, but got: {:?}",
                e
            );
        }
    }

    // Remove agent3
    let _ = call_transaction(
        &contract_id,
        "remove_agent",
        json!({
            "account_id": agent3_id
        }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Verify agent3 is removed
    let agent_info: Data<Option<serde_json::Value>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent3_id
        }),
        &network_config,
    )
    .await?;

    assert!(agent_info.data.is_none(), "Agent3 should be removed");

    // Try to register agent3 again - should fail
    let _ = call_transaction(
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
        &agent3_id,
        &agent3_signer,
        &network_config,
        None,
    )
    .await?
    .assert_failure();

    // Verify agent3 is still removed
    let agent_info: Data<Option<serde_json::Value>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent3_id
        }),
        &network_config,
    )
    .await?;

    assert!(agent_info.data.is_none(), "Agent3 should still be removed");

    // Re-approve codehash
    let _ = call_transaction(
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
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Verify remaining agents (agent1 and agent2) now have codehash_is_approved: true again
    for agent_id in [&agent1_id, &agent2_id] {
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
        assert_eq!(
            agent["codehash_is_approved"], true,
            "Agent {} should have approved codehash again",
            agent_id
        );
    }

    // Verify agents can request signatures again
    let result = call_transaction(
        &contract_id,
        "request_signature",
        json!({
            "path": "path",
            "payload": "test_payload",
            "key_type": "Ecdsa"
        }),
        &agent1_id,
        &agent1_signer,
        &network_config,
        None,
    )
    .await?
    .into_result();

    // Assert that the transaction failed with AccountDoesNotExist for mpc-contract not any other error
    match result {
        Ok(_) => {
            panic!("Expected transaction to fail with AccountDoesNotExist for mpc-contract, but it succeeded");
        }
        Err(e) => {
            let error_str = format!("{:?}", e);
            assert!(
                error_str.contains("AccountDoesNotExist") && error_str.contains("mpc-contract"),
                "Expected AccountDoesNotExist error for mpc-contract, but got: {:?}",
                e
            );
        }
    }

    Ok(())
}
