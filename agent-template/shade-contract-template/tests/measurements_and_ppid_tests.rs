mod helpers;

use helpers::*;
use near_api::Data;
use serde_json::json;
use shade_attestation::attestation::DstackAttestation;
use tokio::time::{Duration, sleep};

// Tests measurements/PPID lifecycle with multiple agents:
// - Verifies that measurements removal affects all registered agents (measurements_are_approved -> false)
// - Ensures agents with removed measurements cannot request signatures
// - Confirms that re-approving measurements restores access for remaining registered agents
// - Validates that removed agents cannot be re-registered even after measurements re-approval
// - Verifies that signature requests are re-enabled after measurements re-approval
#[tokio::test]
async fn test_measurements_and_ppid() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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

    // Default measurements and PPID already approved by deploy_contract_default

    // Whitelist and register all three agents
    for (agent_id, agent_signer) in [
        (&agent1_id, &agent1_signer),
        (&agent2_id, &agent2_signer),
        (&agent3_id, &agent3_signer),
    ] {
        let _ = call_transaction(
            &contract_id,
            "whitelist_agent_for_local",
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
                "attestation": serde_json::to_value(DstackAttestation::default()).unwrap()
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

    // Verify all agents have measurements_are_approved and ppid_is_approved: true
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
            agent["measurements_are_approved"], true,
            "Agent {} should have approved measurements",
            agent_id
        );
        assert_eq!(
            agent["ppid_is_approved"], true,
            "Agent {} should have approved PPID",
            agent_id
        );
    }

    // Remove default measurements
    let _ = call_transaction(
        &contract_id,
        "remove_measurements",
        json!({ "measurements": default_measurements_json() }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Verify all agents now have measurements_are_approved: false
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
            agent["measurements_are_approved"], false,
            "Agent {} should not have approved measurements",
            agent_id
        );
        assert_eq!(
            agent["ppid_is_approved"], true,
            "Agent {} should still have approved PPID",
            agent_id
        );
    }

    // Attempt to request a signature with removed measurements
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

    match result {
        Ok(_) => {
            panic!(
                "Expected transaction to fail with 'Agent not registered with approved measurements', but it succeeded"
            );
        }
        Err(e) => {
            let error_str = format!("{:?}", e);
            assert!(
                error_str.contains("Agent not registered with approved measurements"),
                "Expected 'Agent not registered with approved measurements' error, but got: {:?}",
                e
            );
        }
    }

    // Remove agent3 from agents map
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

    // Verify agent3 is removed (no longer in agents map)
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

    // Remove agent3 from whitelist so they cannot re-register
    let _ = call_transaction(
        &contract_id,
        "remove_agent_for_local",
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

    // Try to register agent3 again - should fail (no longer whitelisted)
    let _ = call_transaction(
        &contract_id,
        "register_agent",
        json!({
            "attestation": serde_json::to_value(DstackAttestation::default()).unwrap()
        }),
        &agent3_id,
        &agent3_signer,
        &network_config,
        None,
    )
    .await?
    .assert_failure();

    // Verify agent3 is still not in agents
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

    // Re-approve measurements
    let _ = call_transaction(
        &contract_id,
        "approve_measurements",
        approve_measurements_default_args(),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Verify remaining agents (agent1 and agent2) now have measurements_are_approved: true again
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
            agent["measurements_are_approved"], true,
            "Agent {} should have approved measurements again",
            agent_id
        );
    }

    // Verify agents can request signatures again (will fail with AccountDoesNotExist for mpc-contract)
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

    match result {
        Ok(_) => {
            panic!(
                "Expected transaction to fail with AccountDoesNotExist for mpc-contract, but it succeeded"
            );
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

    // Now test PPID removal
    // Remove default PPID
    let _ = call_transaction(
        &contract_id,
        "remove_ppids",
        default_ppids_json(),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Verify all agents now have ppid_is_approved: false
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
            agent["measurements_are_approved"], true,
            "Agent {} should still have approved measurements",
            agent_id
        );
        assert_eq!(
            agent["ppid_is_approved"], false,
            "Agent {} should not have approved PPID",
            agent_id
        );
    }

    // Attempt to request a signature with removed PPID
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

    match result {
        Ok(_) => {
            panic!(
                "Expected transaction to fail with 'Agent not registered with approved PPID', but it succeeded"
            );
        }
        Err(e) => {
            let error_str = format!("{:?}", e);
            assert!(
                error_str.contains("Agent not registered with approved PPID"),
                "Expected 'Agent not registered with approved PPID' error, but got: {:?}",
                e
            );
        }
    }

    // Re-approve PPID
    let _ = call_transaction(
        &contract_id,
        "approve_ppids",
        default_ppids_json(),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Verify agents now have ppid_is_approved: true again
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
            agent["ppid_is_approved"], true,
            "Agent {} should have approved PPID again",
            agent_id
        );
    }

    // Try to call request_signature - should now pass PPID check (will fail with AccountDoesNotExist for mpc-contract)
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

    match result {
        Ok(_) => {
            panic!(
                "Expected transaction to fail with AccountDoesNotExist for mpc-contract, but it succeeded"
            );
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

/// Verifies that registration fails when default measurements or default PPID are not approved.
/// In local mode, agents must register with default measurements and default PPID; approving
/// only non-default values should cause registration to fail.
#[tokio::test]
async fn test_register_fails_without_default_measurements_or_ppid(
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;

    let contract_id =
        deploy_contract_default(&network_config, &genesis_account_id, &genesis_signer).await?;

    sleep(Duration::from_millis(200)).await;

    let (agent_id, agent_signer) = create_user_account(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "agent",
    )
    .await?;

    // Whitelist the agent
    let _ = call_transaction(
        &contract_id,
        "whitelist_agent_for_local",
        json!({ "account_id": agent_id }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    // Remove default measurements and approve only non-default ones
    let _ = call_transaction(
        &contract_id,
        "remove_measurements",
        json!({ "measurements": default_measurements_json() }),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    let _ = call_transaction(
        &contract_id,
        "approve_measurements",
        approve_non_default_measurements_args(),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Try to register - should fail (default measurements not approved)
    let result = call_transaction(
        &contract_id,
        "register_agent",
        json!({
            "attestation": serde_json::to_value(DstackAttestation::default()).unwrap()
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        None,
    )
    .await?
    .into_result();

    match result {
        Ok(_) => panic!("Expected register_agent to fail when default measurements not approved"),
        Err(e) => {
            let error_str = format!("{:?}", e);
            assert!(
                error_str.contains("Default measurements must be approved for local mode"),
                "Expected 'Default measurements must be approved for local mode', got: {}",
                error_str
            );
        }
    }

    // Re-approve default measurements
    let _ = call_transaction(
        &contract_id,
        "approve_measurements",
        approve_measurements_default_args(),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    // Remove default PPID and approve only non-default one
    let _ = call_transaction(
        &contract_id,
        "remove_ppids",
        default_ppids_json(),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    let _ = call_transaction(
        &contract_id,
        "approve_ppids",
        non_default_ppids_json(),
        &genesis_account_id,
        &genesis_signer,
        &network_config,
        None,
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Try to register - should fail (default PPID not approved)
    let result = call_transaction(
        &contract_id,
        "register_agent",
        json!({
            "attestation": serde_json::to_value(DstackAttestation::default()).unwrap()
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        None,
    )
    .await?
    .into_result();

    match result {
        Ok(_) => panic!("Expected register_agent to fail when default PPID not approved"),
        Err(e) => {
            let error_str = format!("{:?}", e);
            assert!(
                error_str.contains("Default PPID must be approved for local mode"),
                "Expected 'Default PPID must be approved for local mode', got: {}",
                error_str
            );
        }
    }

    Ok(())
}
