mod helpers;

use helpers::*;
use near_api::Data;
use serde_json::json;
use tokio::time::{sleep, Duration};

/// Tests contract initial state
#[tokio::test]
async fn test_contract_initial_state() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;

    let contract_id =
        deploy_contract_default(&network_config, &genesis_account_id, &genesis_signer).await?;

    sleep(Duration::from_millis(200)).await;

    // Verify get_requires_tee returns correct value
    let requires_tee: Data<bool> =
        call_view(&contract_id, "get_requires_tee", json!({}), &network_config).await?;

    assert_eq!(requires_tee.data, false);

    // Verify initial state: no approved codehashes
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

    assert_eq!(approved_codehashes.data.len(), 0);

    // Verify initial state: no agents
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

    assert_eq!(agents.data.len(), 0);

    // Verify owner can perform operations
    let _ = call_transaction(
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

    Ok(())
}
