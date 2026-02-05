mod helpers;

use helpers::*;
use near_api::Data;
use serde_json::json;
use shade_attestation::attestation::DstackAttestation;
use tokio::time::{Duration, sleep};
use shade_contract_template::AgentView;

/// Tests measurements/PPID lifecycle with multiple agents:
/// - Verifies that measurements removal affects all registered agents (measurements_are_approved -> false)
/// - Ensures agents with removed measurements cannot request signatures and are removed with InvalidMeasurements reason
/// - Ensures agents with removed PPID cannot request signatures and are removed with InvalidPpid reason
/// - Confirms that re-approving measurements restores access for remaining registered agents
/// - Validates that removed agents cannot be re-registered even after measurements re-approval
/// - Verifies that signature requests are re-enabled after measurements re-approval
#[tokio::test]
async fn test_measurements_and_ppid_lifecycle() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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

        // Register agent with 0.005 NEAR deposit
        let _ = call_transaction(
            &contract_id,
            "register_agent",
            json!({
                "attestation": serde_json::to_value(DstackAttestation::default()).unwrap()
            }),
            agent_id,
            agent_signer,
            &network_config,
            Some(helpers::DEPOSIT_005_NEAR),
        )
        .await?
        .assert_success();
    }

    sleep(Duration::from_millis(300)).await;

    // Verify all agents have measurements_are_approved and ppid_is_approved: true
    for agent_id in [&agent1_id, &agent2_id, &agent3_id] {
        let agent_info: Data<Option<AgentView>> = call_view(
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
            agent.measurements_are_approved, true,
            "Agent {} should have approved measurements",
            agent_id
        );
        assert_eq!(
            agent.ppid_is_approved, true,
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
        let agent_info: Data<Option<AgentView>> = call_view(
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
            agent.measurements_are_approved, false,
            "Agent {} should not have approved measurements",
            agent_id
        );
        assert_eq!(
            agent.ppid_is_approved, true,
            "Agent {} should still have approved PPID",
            agent_id
        );
    }

    // Attempt to request a signature with removed measurements
    // This will remove the agent and emit an event, then fail when calling MPC contract
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
    .await?;

    // Verify agent is removed from map (require_valid_agent removed it)
    sleep(Duration::from_millis(200)).await;
    let agent_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent1_id
        }),
        &network_config,
    )
    .await?;

    assert!(agent_info.data.is_none(), "Agent1 should be removed from map");

    // Check event logs to verify removal reason is InvalidMeasurements
    let events = extract_event_logs(&result)?;
    let agent_removed_events: Vec<_> = events
        .iter()
        .filter(|e| {
            e["event"].as_str() == Some("agent_removed")
                && e["data"][0]["account_id"].as_str() == Some(agent1_id.as_str())
        })
        .collect();

    assert_eq!(
        agent_removed_events.len(),
        1,
        "Should have exactly one agent_removed event for agent1"
    );

    let reasons = &agent_removed_events[0]["data"][0]["reasons"];
    assert!(
        reasons.as_array().map_or(false, |r| r.contains(&json!("InvalidMeasurements"))),
        "Event should contain 'InvalidMeasurements' reason, got: {:?}",
        reasons
    );

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
    let agent_info: Data<Option<AgentView>> = call_view(
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
        "remove_agent_from_whitelist_for_local",
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
        Some(helpers::DEPOSIT_005_NEAR),
    )
    .await?
    .assert_failure();

    // Verify agent3 is still not in agents
    let agent_info: Data<Option<AgentView>> = call_view(
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

    // Verify agent1 was removed (it was removed when request_signature was called with invalid measurements)
    let agent1_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent1_id
        }),
        &network_config,
    )
    .await?;
    assert!(agent1_info.data.is_none(), "Agent1 should still be removed");

    // Verify agent2 still exists and now has measurements_are_approved: true again
    let agent2_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent2_id
        }),
        &network_config,
    )
    .await?;

    let agent2 = agent2_info.data.unwrap();
    assert_eq!(
        agent2.measurements_are_approved, true,
        "Agent2 should have approved measurements again"
    );

    // Agent1 was removed, so request_signature should fail with "Agent not registered"
    // Agent2 can request signatures again (will fail with AccountDoesNotExist for mpc-contract)
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
            panic!("Expected transaction to fail with 'Agent not registered', but it succeeded");
        }
        Err(e) => {
            let error_str = format!("{:?}", e);
            assert!(
                error_str.contains("Agent not registered"),
                "Expected 'Agent not registered' error, but got: {:?}",
                e
            );
        }
    }

    // Agent2 can request signatures again (will fail with AccountDoesNotExist for mpc-contract)
    let result = call_transaction(
        &contract_id,
        "request_signature",
        json!({
            "path": "path",
            "payload": "test_payload",
            "key_type": "Ecdsa"
        }),
        &agent2_id,
        &agent2_signer,
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

    // Verify agent1 was already removed earlier, agent2 still exists with ppid_is_approved: false
    let agent1_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent1_id
        }),
        &network_config,
    )
    .await?;
    assert!(agent1_info.data.is_none(), "Agent1 should still be removed");

    let agent2_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent2_id
        }),
        &network_config,
    )
    .await?;

    let agent2 = agent2_info.data.unwrap();
    assert_eq!(
        agent2.measurements_are_approved, true,
        "Agent2 should still have approved measurements"
    );
    assert_eq!(
        agent2.ppid_is_approved, false,
        "Agent2 should not have approved PPID"
    );

    // Attempt to request a signature with removed PPID using agent2
    // This will remove agent2 and emit an event, then fail when calling MPC contract
    let result = call_transaction(
        &contract_id,
        "request_signature",
        json!({
            "path": "path",
            "payload": "test_payload",
            "key_type": "Ecdsa"
        }),
        &agent2_id,
        &agent2_signer,
        &network_config,
        None,
    )
    .await?;

    // Verify agent2 is removed from map (require_valid_agent removed it)
    sleep(Duration::from_millis(200)).await;
    let agent2_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent2_id
        }),
        &network_config,
    )
    .await?;

    assert!(agent2_info.data.is_none(), "Agent2 should be removed from map");

    // Check event logs to verify removal reason is InvalidPpid
    let events = extract_event_logs(&result)?;
    let agent_removed_events: Vec<_> = events
        .iter()
        .filter(|e| {
            e["event"].as_str() == Some("agent_removed")
                && e["data"][0]["account_id"].as_str() == Some(agent2_id.as_str())
        })
        .collect();

    assert_eq!(
        agent_removed_events.len(),
        1,
        "Should have exactly one agent_removed event for agent2"
    );

    let reasons = &agent_removed_events[0]["data"][0]["reasons"];
    assert!(
        reasons.as_array().map_or(false, |r| r.contains(&json!("InvalidPpid"))),
        "Event should contain 'InvalidPpid' reason, got: {:?}",
        reasons
    );

    // The transaction may succeed (agent removed, event emitted) or fail later (MPC contract call)
    // Either way, the important thing is that the agent was removed

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

    // Verify both agents were removed (agent1 was removed earlier, agent2 was removed when PPID was invalid)
    let agent1_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent1_id
        }),
        &network_config,
    )
    .await?;
    assert!(agent1_info.data.is_none(), "Agent1 should still be removed");

    let agent2_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent2_id
        }),
        &network_config,
    )
    .await?;
    assert!(agent2_info.data.is_none(), "Agent2 should still be removed");

    // Both agents were removed, so request_signature should fail with "Agent not registered"
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
            panic!("Expected transaction to fail with 'Agent not registered', but it succeeded");
        }
        Err(e) => {
            let error_str = format!("{:?}", e);
            assert!(
                error_str.contains("Agent not registered"),
                "Expected 'Agent not registered' error, but got: {:?}",
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
async fn test_register_fails_without_default_measurements_or_ppid()
-> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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
        Some(helpers::DEPOSIT_005_NEAR),
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
        Some(helpers::DEPOSIT_005_NEAR),
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

/// Tests attestation expiration using sandbox fast_forward and verifies agent can re-register afterwards
#[tokio::test]
async fn test_attestation_expiration() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;

    let contract_id =
        deploy_contract_default(&network_config, &genesis_account_id, &genesis_signer).await?;

    sleep(Duration::from_millis(200)).await;

    // Create and register agent
    let (agent_id, agent_signer) = create_user_account(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "agent",
    )
    .await?;

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

    // Register agent with 0.005 NEAR deposit
    let _ = call_transaction(
        &contract_id,
        "register_agent",
        json!({
            "attestation": serde_json::to_value(DstackAttestation::default()).unwrap()
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        Some(helpers::DEPOSIT_005_NEAR),
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Check agent info - should not be expired
    let agent_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent_id
        }),
        &network_config,
    )
    .await?;

    let agent = agent_info.data.unwrap();
    assert_eq!(agent.timestamp_is_valid, true, "Agent timestamp should be valid (not expired)");
    assert_eq!(agent.is_valid, true, "Agent should be valid");

    // Fast forward time past expiration (attestation_expiration_time_ms is 100000 ms = 100 seconds)
    // NEAR blocks are produced roughly every 1 second, so we need at least 100 blocks for 100 seconds
    // Fast forward by 500 blocks to ensure we're well past expiration
    sandbox.fast_forward(500).await?;

    sleep(Duration::from_millis(200)).await;

    // Check agent info - should be expired
    let agent_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent_id
        }),
        &network_config,
    )
    .await?;

    let agent = agent_info.data.unwrap();
    assert_eq!(agent.timestamp_is_valid, false, "Agent timestamp should not be valid (expired)");
    assert_eq!(agent.is_valid, false, "Agent should not be valid");

    // Try to request signature - should remove agent and emit event with ExpiredAttestation reason
    let result = call_transaction(
        &contract_id,
        "request_signature",
        json!({
            "path": "path",
            "payload": "test_payload",
            "key_type": "Ecdsa"
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        None,
    )
    .await?;

    sleep(Duration::from_millis(200)).await;

    // Verify agent is removed from map
    let agent_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent_id
        }),
        &network_config,
    )
    .await?;

    assert!(agent_info.data.is_none(), "Agent should be removed from map");

    // Check event logs to verify removal reason
    let events = extract_event_logs(&result)?;
    let agent_removed_events: Vec<_> = events
        .iter()
        .filter(|e| {
            e["event"].as_str() == Some("agent_removed")
                && e["data"][0]["account_id"].as_str() == Some(agent_id.as_str())
        })
        .collect();

    assert_eq!(
        agent_removed_events.len(),
        1,
        "Should have exactly one agent_removed event"
    );

    let reasons = &agent_removed_events[0]["data"][0]["reasons"];
    assert!(
        reasons.as_array().map_or(false, |r| r.contains(&json!("ExpiredAttestation"))),
        "Event should contain 'ExpiredAttestation' reason, got: {:?}",
        reasons
    );

    // Next call should panic because agent is not registered
    let result = call_transaction(
        &contract_id,
        "request_signature",
        json!({
            "path": "path",
            "payload": "test_payload",
            "key_type": "Ecdsa"
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        None,
    )
    .await?
    .into_result();

    match result {
        Ok(_) => {
            panic!("Expected transaction to fail with 'Agent not registered', but it succeeded");
        }
        Err(e) => {
            let error_str = format!("{:?}", e);
            assert!(
                error_str.contains("Agent not registered"),
                "Expected 'Agent not registered' error, but got: {:?}",
                e
            );
        }
    }

    // Agent is still whitelisted, so they can re-register after expiration
    let _ = call_transaction(
        &contract_id,
        "register_agent",
        json!({
            "attestation": serde_json::to_value(DstackAttestation::default()).unwrap()
        }),
        &agent_id,
        &agent_signer,
        &network_config,
        Some(helpers::DEPOSIT_005_NEAR),
    )
    .await?
    .assert_success();

    sleep(Duration::from_millis(200)).await;

    // Verify agent is registered again and valid
    let agent_info: Data<Option<AgentView>> = call_view(
        &contract_id,
        "get_agent",
        json!({
            "account_id": agent_id
        }),
        &network_config,
    )
    .await?;

    let agent = agent_info.data.unwrap();
    assert_eq!(agent.timestamp_is_valid, true, "Agent timestamp should be valid after re-registration");
    assert_eq!(agent.is_valid, true, "Agent should be valid after re-registration");

    Ok(())
}
