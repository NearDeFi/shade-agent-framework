use hex;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    env::{self, block_timestamp_ms},
    ext_contract,
    json_types::U64,
    log, near, require,
    serde::Serialize,
    serde_json,
    store::{IterableMap, IterableSet},
};
use shade_attestation::{
    attestation::DstackAttestation,
    measurements::{FullMeasurements, FullMeasurementsHex},
    report_data::ReportData,
    tcb_info::HexBytes,
};

use events::{AgentRemovalReason, Event};

mod attestation;
mod chainsig;
mod events;
mod helpers;
mod update_contract;
mod views;
mod your_functions;

// Re-export view types for use in tests
pub use views::{AgentView, ContractInfo};

#[cfg(test)]
mod unit_tests;

type Ppid = HexBytes<16>;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub requires_tee: bool,
    pub attestation_expiration_time_ms: u64,
    pub owner_id: AccountId,
    pub mpc_contract_id: AccountId,
    pub approved_measurements: IterableSet<FullMeasurementsHex>,
    pub approved_ppids: IterableSet<Ppid>,
    pub agents: IterableMap<AccountId, Agent>,
    pub whitelisted_agents_for_local: IterableSet<AccountId>,
}

#[near(serializers = [borsh])]
pub struct Agent {
    pub measurements: FullMeasurementsHex,
    pub ppid: Ppid,
    pub valid_until_ms: u64,
}

#[derive(BorshStorageKey)]
#[near]
pub enum StorageKey {
    ApprovedMeasurements,
    ApprovedPpids,
    Agents,
    WhitelistedAgentsForLocal,
}

const STORAGE_BYTES_TO_REGISTER: u128 = 486;

#[near]
impl Contract {
    #[init]
    #[private]
    pub fn new(
        requires_tee: bool,
        attestation_expiration_time_ms: U64,
        owner_id: AccountId,
        mpc_contract_id: AccountId,
    ) -> Self {
        Self {
            requires_tee,
            attestation_expiration_time_ms: attestation_expiration_time_ms.into(),
            owner_id,
            mpc_contract_id, // Set to v1.signer-prod.testnet for testnet, v1.signer for mainnet
            approved_measurements: IterableSet::new(StorageKey::ApprovedMeasurements),
            approved_ppids: IterableSet::new(StorageKey::ApprovedPpids),
            agents: IterableMap::new(StorageKey::Agents),
            whitelisted_agents_for_local: IterableSet::new(StorageKey::WhitelistedAgentsForLocal),
        }
    }

    // Register an agent, this needs to be called by the agent itself
    #[payable]
    pub fn register_agent(&mut self, attestation: DstackAttestation) -> bool {
        // Require the agent to pay for the storage cost
        // You should update the storage_bytes if you store more data
        let storage_cost = env::storage_byte_cost()
            .checked_mul(STORAGE_BYTES_TO_REGISTER)
            .unwrap();
        require!(
            env::attached_deposit() >= storage_cost,
            &format!(
                "Attached deposit must be greater than storage cost {:?}",
                storage_cost.exact_amount_display()
            )
        );

        // Verify the attestation and get the measurements and PPID
        let (measurements, ppid) = self.verify_attestation(attestation.clone());

        let valid_until_ms = block_timestamp_ms() + self.attestation_expiration_time_ms;

        Event::AgentRegistered {
            account_id: &env::predecessor_account_id(),
            measurements: &measurements,
            ppid: &ppid,
            current_time_ms: U64::from(block_timestamp_ms()),
            valid_until_ms: U64::from(valid_until_ms),
        }
        .emit();

        // Agent is valid for the attestation expiration time
        // Register the agent
        self.agents.insert(
            env::predecessor_account_id(),
            Agent {
                measurements,
                ppid,
                valid_until_ms,
            },
        );

        true
    }

    // Owner methods

    // Update the attestation expiration time
    pub fn update_attestation_expiration_time(&mut self, attestation_expiration_time_ms: U64) {
        self.require_owner();
        self.attestation_expiration_time_ms = attestation_expiration_time_ms.into();
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

    // Add a new measurements to the approved list
    pub fn approve_measurements(&mut self, measurements: FullMeasurementsHex) {
        self.require_owner();
        self.approved_measurements.insert(measurements);
    }

    // Remove a measurements from the approved list
    pub fn remove_measurements(&mut self, measurements: FullMeasurementsHex) {
        self.require_owner();
        require!(
            self.approved_measurements.remove(&measurements),
            "Measurements not in approved list"
        );
    }

    // Add one or more PPIDs to the approved list
    pub fn approve_ppids(&mut self, ppids: Vec<HexBytes<16>>) {
        self.require_owner();
        for id in ppids {
            self.approved_ppids.insert(id);
        }
    }

    // Remove one or more PPIDs from the approved list.
    pub fn remove_ppids(&mut self, ppids: Vec<HexBytes<16>>) {
        self.require_owner();
        for id in ppids {
            require!(self.approved_ppids.remove(&id), "PPID not in approved list");
        }
    }

    // Remove an agent from the approved list
    pub fn remove_agent(&mut self, account_id: AccountId) {
        self.require_owner();
        require!(
            self.agents.remove(&account_id).is_some(),
            "Agent not registered"
        );
        Event::AgentRemoved {
            account_id: &account_id,
            reasons: vec![AgentRemovalReason::ManualRemoval],
        }
        .emit();
    }

    // Local only functions

    // Whitelist an agent, it will still need to register
    pub fn whitelist_agent_for_local(&mut self, account_id: AccountId) {
        if self.requires_tee {
            panic!("Whitelisting agents is not supported for TEE");
        }
        self.require_owner();
        // Only insert if not already whitelisted
        self.whitelisted_agents_for_local.insert(account_id);
    }

    // Remove an agent from the list of agents
    pub fn remove_agent_from_whitelist_for_local(&mut self, account_id: AccountId) {
        if self.requires_tee {
            panic!("Removing agents is not supported for TEE");
        }
        self.require_owner();
        require!(
            self.whitelisted_agents_for_local.remove(&account_id),
            "Agent not in whitelist for local"
        );
    }
}
