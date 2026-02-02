use hex;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    env::{self, block_timestamp_ms},
    ext_contract, log, near, require,
    store::{IterableMap, IterableSet},
};
use serde::Serialize;
use shade_attestation::{
    attestation::DstackAttestation,
    measurements::{FullMeasurements, FullMeasurementsHex},
    report_data::ReportData,
    tcb_info::HexBytes,
};

mod attestation;
mod chainsig;
mod helpers;
mod update_contract;
mod views;

#[cfg(test)]
mod unit_tests;

type Ppid = HexBytes<16>;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub requires_tee: bool,
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
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct AgentView {
    pub account_id: AccountId,
    pub measurements: FullMeasurementsHex,
    pub measurements_are_approved: bool,
    pub ppid: Ppid,
    pub ppid_is_approved: bool,
}

#[derive(BorshStorageKey)]
#[near]
pub enum StorageKey {
    ApprovedMeasurements,
    ApprovedPpids,
    Agents,
    WhitelistedAgentsForLocal,
}

#[near]
impl Contract {
    #[init]
    #[private]
    pub fn new(requires_tee: bool, owner_id: AccountId, mpc_contract_id: AccountId) -> Self {
        Self {
            requires_tee,
            owner_id,
            mpc_contract_id, // Set to v1.signer-prod.testnet for testnet, v1.signer for mainnet
            approved_measurements: IterableSet::new(StorageKey::ApprovedMeasurements),
            approved_ppids: IterableSet::new(StorageKey::ApprovedPpids),
            agents: IterableMap::new(StorageKey::Agents),
            whitelisted_agents_for_local: IterableSet::new(StorageKey::WhitelistedAgentsForLocal),
        }
    }

    // Register an agent, this needs to be called by the agent itself
    // Note agent registration does not implement storage management, you should implement this
    pub fn register_agent(&mut self, attestation: DstackAttestation) -> bool {
        // Verify the attestation and get the measurements and PPID
        let (measurements, ppid) = self.verify_attestation(attestation);

        // Register the agent
        self.agents
            .insert(env::predecessor_account_id(), Agent { measurements, ppid });

        true
    }

    // Request a signature for a transaction payload
    pub fn request_signature(
        &mut self,
        path: String,
        payload: String,
        key_type: String,
    ) -> Promise {
        // Require the caller to be a valid agent
        self.require_valid_agent();

        self.internal_request_signature(path, payload, key_type)
    }

    // Owner methods

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

    // Add one or more PPIDs to the approved list.
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
            require!(
                self.approved_ppids.remove(&id),
                "PPID not in approved list"
            );
        }
    }

    // Remove an agent from the approved list.
    pub fn remove_agent(&mut self, account_id: AccountId) {
        self.require_owner();
        require!(
            self.agents.remove(&account_id).is_some(),
            "Agent not registered"
        );
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
    pub fn remove_agent_for_local(&mut self, account_id: AccountId) {
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
