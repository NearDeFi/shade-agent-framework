// Test Helpers
use near_api::{
    signer, Account, AccountId, Contract, NearToken, NetworkConfig, RPCEndpoint, Signer,
};
use near_api_types::transaction::result::ExecutionFinalResult;
use near_sandbox::{GenesisAccount, Sandbox};
use serde_json::json;
use std::sync::Arc;
use tokio::time::{sleep, Duration};

#[allow(dead_code)]
pub const CONTRACT_WASM_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/target/near/shade_contract.wasm"
);
#[allow(dead_code)]
pub const MOCK_MPC_WASM_PATH: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/tests/contracts/mock_mpc.wasm");

#[allow(dead_code)]
pub fn create_network_config(sandbox: &Sandbox) -> NetworkConfig {
    NetworkConfig {
        network_name: "sandbox".to_string(),
        rpc_endpoints: vec![RPCEndpoint::new(sandbox.rpc_addr.parse().unwrap())],
        ..NetworkConfig::testnet()
    }
}

#[allow(dead_code)]
pub async fn setup_genesis_account() -> (AccountId, Arc<Signer>) {
    let genesis_account_default = GenesisAccount::default();
    let genesis_account_id: AccountId = genesis_account_default
        .account_id
        .to_string()
        .parse()
        .unwrap();
    let genesis_signer: Arc<Signer> =
        Signer::from_secret_key(genesis_account_default.private_key.parse().unwrap()).unwrap();

    (genesis_account_id, genesis_signer)
}

#[allow(dead_code)]
pub async fn deploy_contract(
    network_config: &NetworkConfig,
    genesis_account_id: &AccountId,
    genesis_signer: &Arc<Signer>,
    wasm_path: &str,
    init_method: Option<&str>,
    init_args: Option<serde_json::Value>,
    account_id: Option<AccountId>,
) -> Result<AccountId, Box<dyn std::error::Error + Send + Sync>> {
    // Create contract account
    let contract_id =
        account_id.unwrap_or_else(|| format!("contract.{}", genesis_account_id).parse().unwrap());
    let contract_secret_key = signer::generate_secret_key()?;

    let _ = Account::create_account(contract_id.clone())
        .fund_myself(genesis_account_id.clone(), NearToken::from_near(10))
        .with_public_key(contract_secret_key.public_key())
        .with_signer(genesis_signer.clone())
        .send_to(network_config)
        .await?;

    // Read and deploy contract WASM
    let wasm_bytes = std::fs::read(wasm_path)?;
    let contract_signer: Arc<Signer> = Signer::from_secret_key(contract_secret_key)?;

    // Deploy contract
    let mut deploy_result = None;
    let mut last_error_str = None;
    for attempt in 1..=3 {
        // Retry
        let result = if let (Some(method), Some(args)) = (init_method, init_args.as_ref()) {
            // Deploy with init call
            Contract::deploy(contract_id.clone())
                .use_code(wasm_bytes.clone())
                .with_init_call(method, args.clone())?
                .with_signer(contract_signer.clone())
                .send_to(network_config)
                .await
        } else {
            // Deploy without init call
            Contract::deploy(contract_id.clone())
                .use_code(wasm_bytes.clone())
                .without_init_call()
                .with_signer(contract_signer.clone())
                .send_to(network_config)
                .await
        };

        match result {
            Ok(result) => {
                deploy_result = Some(result);
                break;
            }
            Err(e) => {
                let error_str = format!("{:?}", e);
                if error_str.contains("408")
                    || error_str.contains("timeout")
                    || error_str.contains("Timeout")
                    || error_str.contains("TransportError")
                {
                    println!(
                        "Deployment attempt {} timed out (408), retrying... (attempt {}/3)",
                        attempt, attempt
                    );
                    last_error_str = Some(error_str);
                    if attempt < 3 {
                        sleep(Duration::from_millis(1000)).await;
                        continue;
                    }
                } else {
                    return Err(format!("Contract deployment failed: {:?}", e).into());
                }
            }
        }
    }

    let deploy_result = deploy_result.ok_or_else(|| {
        format!(
            "Contract deployment failed after 3 attempts due to timeout. Last error: {:?}",
            last_error_str.unwrap_or_else(|| "Unknown".to_string())
        )
    })?;

    // Check if deploy succeeded
    // If the error is "already been initialized", that means the contract was deployed in a previous attempt
    // (likely a timeout that actually succeeded), so we treat it as success
    if let Err(e) = deploy_result.into_result() {
        let error_str = format!("{:?}", e);
        println!("Deployment result error: {}", error_str);
        if error_str.contains("already been initialized")
            || error_str.contains("already initialized")
            || error_str.contains("The contract has already been initialized")
            || error_str
                .contains("Smart contract panicked: The contract has already been initialized")
        {
            println!("Contract already initialized (likely from previous timeout attempt), treating as success");
            // Contract is deployed and initialized, we're good
        } else {
            return Err(format!("Contract deploy/init failed: {:?}", e).into());
        }
    }

    // Wait a bit for the deployment to finalize
    sleep(Duration::from_millis(300)).await;

    Ok(contract_id)
}

#[allow(dead_code)]
pub async fn deploy_contract_default(
    network_config: &NetworkConfig,
    genesis_account_id: &AccountId,
    genesis_signer: &Arc<Signer>,
) -> Result<AccountId, Box<dyn std::error::Error + Send + Sync>> {
    let owner = genesis_account_id.clone();
    let mpc_contract: AccountId = "mpc-contract".parse().unwrap();

    deploy_contract(
        network_config,
        genesis_account_id,
        genesis_signer,
        CONTRACT_WASM_PATH,
        Some("new"),
        Some(json!({
            "owner_id": owner,
            "mpc_contract_id": mpc_contract,
            "requires_tee": false
        })),
        None,
    )
    .await
}

#[allow(dead_code)]
pub async fn create_user_account(
    network_config: &NetworkConfig,
    genesis_account_id: &AccountId,
    genesis_signer: &Arc<Signer>,
    user_name: &str,
) -> Result<(AccountId, Arc<Signer>), Box<dyn std::error::Error + Send + Sync>> {
    let user_id: AccountId = format!("{}.{}", user_name, genesis_account_id).parse()?;
    let user_secret_key = signer::generate_secret_key()?;
    let user_signer: Arc<Signer> = Signer::from_secret_key(user_secret_key.clone())?;

    let _ = Account::create_account(user_id.clone())
        .fund_myself(genesis_account_id.clone(), NearToken::from_near(5))
        .with_public_key(user_secret_key.public_key())
        .with_signer(genesis_signer.clone())
        .send_to(network_config)
        .await?;

    Ok((user_id, user_signer))
}

#[allow(dead_code)]
pub async fn call_view<T: serde::de::DeserializeOwned + Send + Sync>(
    contract_id: &AccountId,
    method_name: &str,
    args: serde_json::Value,
    network_config: &NetworkConfig,
) -> Result<near_api::Data<T>, Box<dyn std::error::Error + Send + Sync>> {
    let contract = Contract(contract_id.clone());
    let result: near_api::Data<T> = contract
        .call_function(method_name, args)
        .read_only()
        .fetch_from(network_config)
        .await?;
    Ok(result)
}

#[allow(dead_code)]
pub async fn call_transaction(
    contract_id: &AccountId,
    method_name: &str,
    args: serde_json::Value,
    signer_account_id: &AccountId,
    signer: &Arc<Signer>,
    network_config: &NetworkConfig,
    deposit: Option<NearToken>,
) -> Result<ExecutionFinalResult, Box<dyn std::error::Error + Send + Sync>> {
    let contract = Contract(contract_id.clone());
    let call = contract.call_function(method_name, args);

    let mut tx = call.transaction();

    if let Some(dep) = deposit {
        tx = tx.deposit(dep);
    }

    let result = tx
        .with_signer(signer_account_id.clone(), signer.clone())
        .send_to(network_config)
        .await?;

    Ok(result)
}

#[allow(dead_code)]
pub async fn call_transaction_raw(
    contract_id: &AccountId,
    method_name: &str,
    args: Vec<u8>,
    signer_account_id: &AccountId,
    signer: &Arc<Signer>,
    network_config: &NetworkConfig,
) -> Result<ExecutionFinalResult, Box<dyn std::error::Error + Send + Sync>> {
    let contract = Contract(contract_id.clone());
    let call = contract.call_function_raw(method_name, args);

    let tx = call.transaction();

    let result = tx
        .with_signer(signer_account_id.clone(), signer.clone())
        .send_to(network_config)
        .await?;

    Ok(result)
}

#[allow(dead_code)]
pub async fn deploy_mock_mpc_contract(
    network_config: &NetworkConfig,
    genesis_account_id: &AccountId,
    genesis_signer: &Arc<Signer>,
    contract_name: &str,
) -> Result<AccountId, Box<dyn std::error::Error + Send + Sync>> {
    let mpc_contract_id: AccountId = format!("{}.{}", contract_name, genesis_account_id).parse()?;

    // Deploy mock MPC contract without init using deploy_contract
    deploy_contract(
        network_config,
        genesis_account_id,
        genesis_signer,
        MOCK_MPC_WASM_PATH,
        None,
        None,
        Some(mpc_contract_id.clone()),
    )
    .await?;

    Ok(mpc_contract_id)
}
