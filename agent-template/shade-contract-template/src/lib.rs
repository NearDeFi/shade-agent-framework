use near_sdk::{
    env::{self, block_timestamp_ms},
    near, require, log,
    store::{IterableMap, IterableSet},
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
};
use shade_attestation::{
    attestation::DstackAttestation,
    measurements::{FullMeasurements, FullMeasurementsHex},
    report_data::ReportData,
    tcb_info::HexBytes,
};
use hex;

mod chainsig;
mod helpers;
mod update_contract;
mod views;

#[cfg(test)]
mod unit_tests;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub owner_id: AccountId,
    pub approved_measurements: IterableSet<FullMeasurementsHex>,
    pub agents: IterableMap<AccountId, Option<FullMeasurementsHex>>,
    pub requires_tee: bool,
    pub mpc_contract_id: AccountId,
    pub approved_ppids: IterableSet<HexBytes<16>>,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct Agent {
    account_id: AccountId,
    registered: bool,
    whitelisted: bool,
    measurements: Option<FullMeasurementsHex>,
    measurements_are_approved: bool,
}

#[derive(BorshStorageKey)]
#[near]
pub enum StorageKey {
    ApprovedMeasurements,
    Agents,
    ApprovedPpids,
}

#[near]
impl Contract {
    #[init]
    #[private]
    pub fn new(owner_id: AccountId, mpc_contract_id: AccountId, requires_tee: bool) -> Self {
        Self {
            owner_id,
            mpc_contract_id, // Set to v1.signer-prod.testnet for testnet, v1.signer for mainnet
            requires_tee,
            approved_measurements: IterableSet::new(StorageKey::ApprovedMeasurements),
            agents: IterableMap::new(StorageKey::Agents),
            approved_ppids: IterableSet::new(StorageKey::ApprovedPpids),
        }
    }

    // Register an agent, this needs to be called by the agent itself
    pub fn register_agent(&mut self, attestation: DstackAttestation) -> bool {
        // Check that the agent is whitelisted
        self.agents
            .get(&env::predecessor_account_id())
            .expect("Agent needs to be whitelisted first");

        let measurements: FullMeasurementsHex = match self.requires_tee {
            true => {
                // Get the current time 
                let current_time_seconds = block_timestamp_ms() / 1000;

                let account_id_str = env::predecessor_account_id().to_string();
                
                // Verify account_id is implicit account
                require!(
                    account_id_str.len() == 64 && account_id_str.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()),
                    "Account ID must be implicit account"
                );
                
                // Decode hex string to bytes
                let account_id_bytes = hex::decode(&account_id_str)
                    .expect("Failed to decode account ID");
                
                // Create report data by padding account ID to 64 bytes by appending 32 zero bytes
                let mut report_data_bytes = [0u8; 64];
                report_data_bytes[..32].copy_from_slice(&account_id_bytes);
                let expected_report_data = ReportData::from(report_data_bytes);

                // Convert IterableSet to Vec and convert to FullMeasurements for the verify method
                let expected_measurements: Vec<FullMeasurements> = self.approved_measurements
                    .iter()
                    .cloned()
                    .map(Into::into)
                    .collect();

                let approved_ppids: Vec<HexBytes<16>> = self.approved_ppids.iter().cloned().collect();

                match attestation.verify(expected_report_data, current_time_seconds, &expected_measurements, &approved_ppids) {
                    Ok(verified_measurements) => {
                        log!("Attestation verified successfully");
                        verified_measurements.into()
                    }
                    Err(e) => {
                        panic!("Attestation verification failed: {}", e);
                    }
                }
            }
            false => {
                // All zeros for non-TEE
                let default_measurements = FullMeasurementsHex::default();
                require!(
                    self.approved_measurements.contains(&default_measurements),
                    "Default measurements must be approved for non-TEE mode"
                );
                default_measurements
            }
        };

        // Register the agent with the measurements
        self.agents
            .insert(env::predecessor_account_id(), Some(measurements));

        true
    }

    // Request a signature for a transaction payload
    pub fn request_signature(
        &mut self,
        path: String,
        payload: String,
        key_type: String,
    ) -> Promise {
        // Require the caller to be a registered agent
        self.require_registered_agent();

        self.internal_request_signature(path, payload, key_type)
    }

    // Owner methods

    // Add a new measurements to the approved list
    pub fn approve_measurements(&mut self, measurements: FullMeasurementsHex) {
        self.require_owner();
        self.approved_measurements.insert(measurements);
    }

    // Remove a measurements from the approved list
    pub fn remove_measurements(&mut self, measurements: FullMeasurementsHex) {
        self.require_owner();
        self.approved_measurements.remove(&measurements);
    }

    // Whitelist an agent, it will still need to register
    pub fn whitelist_agent(&mut self, account_id: AccountId) {
        self.require_owner();
        // Only insert if not already whitelisted
        if !self.agents.contains_key(&account_id) {
            self.agents.insert(account_id, None);
        }
    }

    // Remove an agent from the list of agents
    pub fn remove_agent(&mut self, account_id: AccountId) {
        self.require_owner();
        self.agents.remove(&account_id);
    }

    // Update owner ID
    pub fn update_owner_id(&mut self, owner_id: AccountId) {
        self.require_owner();
        self.owner_id = owner_id;
    }

    // Update the MPC contract ID
    pub fn update_mpc_contract_id(&mut self, mpc_contract_id: AccountId) {
        self.require_owner();
        self.mpc_contract_id = mpc_contract_id;
    }

    // Add one or more PPIDs to the approved list.
    pub fn approve_ppids(&mut self, ppids: Vec<HexBytes<16>>) {
        // self.require_owner();
        for id in ppids {
            self.approved_ppids.insert(id);
        }
    }

    // Remove one or more PPIDs from the approved list.
    pub fn remove_ppids(&mut self, ppids: Vec<HexBytes<16>>) {
        // self.require_owner();
        for id in ppids {
            self.approved_ppids.remove(&id);
        }
    }
}
