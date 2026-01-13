mod helpers;

use helpers::*;
use near_api::Data;
use serde_json::json;
use tokio::time::{sleep, Duration};

/// Tests owner transfer and new owner operations
#[tokio::test]
async fn test_owner_transfer_and_new_owner_operations(
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let network_config = create_network_config(&sandbox);
    let (genesis_account_id, genesis_signer) = setup_genesis_account().await;

    let contract_id =
        deploy_contract_default(&network_config, &genesis_account_id, &genesis_signer).await?;

    sleep(Duration::from_millis(200)).await;

    // Create new owner account
    let (new_owner_id, new_owner_signer) = create_user_account(
        &network_config,
        &genesis_account_id,
        &genesis_signer,
        "new_owner",
    )
    .await?;

    // Transfer ownership
    let _ = call_transaction(
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
    .await?
    .assert_success();

    sleep(Duration::from_millis(500)).await;

    // Verify old owner cannot approve codehash
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
    .await?
    .assert_failure();

    // Verify codehash was not approved
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

    assert!(approved_codehashes.data.is_empty());

    // Verify new owner can approve codehash
    let _ = call_transaction(
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
    .await?
    .assert_success();

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

    Ok(())
}
