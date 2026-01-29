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
mod attestation;

#[cfg(test)]
mod unit_tests;

type Ppid = HexBytes<16>;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub owner_id: AccountId,
    pub approved_measurements: IterableSet<FullMeasurementsHex>,
    pub agents: IterableMap<AccountId, Agent>,
    pub requires_tee: bool,
    pub mpc_contract_id: AccountId,
    pub approved_ppids: IterableSet<Ppid>,
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
    Agents,
    ApprovedPpids,
    WhitelistedAgentsForLocal,
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
            whitelisted_agents_for_local: IterableSet::new(StorageKey::WhitelistedAgentsForLocal),
        }
    }

    // Register an agent, this needs to be called by the agent itself
    // Note agent registration does not implement storage management, you should implement this
    pub fn register_agent(&mut self, attestation: DstackAttestation) -> bool {
        // Verify the attestation and get the measurements (and verified PPID; we only store measurements)
        let (measurements, verified_ppid) = self.verify_attestation(attestation);

        // Register the agent with the measurements
        self.agents
            .insert(env::predecessor_account_id(), Agent {
                measurements,
                ppid: verified_ppid,
            });

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
        self.require_valid_agent();

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
        self.require_owner();
        for id in ppids {
            self.approved_ppids.insert(id);
        }
    }

    // Remove one or more PPIDs from the approved list.
    pub fn remove_ppids(&mut self, ppids: Vec<HexBytes<16>>) {
        self.require_owner();
        for id in ppids {
            self.approved_ppids.remove(&id);
        }
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
        self.whitelisted_agents_for_local.remove(&account_id);
    }
}
