use dcap_qvl::{verify, QuoteCollateralV3};
use hex::{decode, encode};
use near_sdk::{
    env::{self, block_timestamp},
    near, require,
    store::{IterableMap, IterableSet},
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
};

mod chainsig;
mod collateral;
mod helpers;
mod upgrade;
mod views;

#[cfg(test)]
mod unit_test;

pub type Codehash = String;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub owner_id: AccountId,
    pub approved_codehashes: IterableSet<Codehash>,
    pub agents: IterableMap<AccountId, Option<Codehash>>,
    pub requires_tee: bool,
    pub mpc_contract_id: AccountId,
}

#[near(serializers = [json])]
pub struct Attestation {
    pub quote_hex: String,
    pub collateral: String,
    pub checksum: String,
    pub tcb_info: String,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct Agent {
    account_id: AccountId,
    registered: bool,
    whitelisted: bool,
    codehash: Option<Codehash>,
    codehash_is_approved: bool,
}

#[derive(BorshStorageKey)]
#[near]
pub enum StorageKey {
    ApprovedCodehashes,
    Agents,
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
            approved_codehashes: IterableSet::new(StorageKey::ApprovedCodehashes),
            agents: IterableMap::new(StorageKey::Agents),
        }
    }

    // Register an agent, this needs to be called by the agent itself
    pub fn register_agent(&mut self, attestation: Attestation) -> bool {
        // Check that the agent is whitelisted
        self.agents
            .get(&env::predecessor_account_id())
            .expect("Agent needs to be whitelisted first");

        let codehash = match self.requires_tee {
            true => {
                // Verify the attestation and get the codehash from the agent
                collateral::verify_attestation(attestation)
            }
            false => {
                // Register the agent without TEE verification
                "not-in-a-tee".to_string()
            }
        };

        // Verify the codehash is approved
        require!(self.approved_codehashes.contains(&codehash));

        // Register the agent with the codehash
        self.agents
            .insert(env::predecessor_account_id(), Some(codehash));

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

    // Add a new codehash to the approved list
    pub fn approve_codehash(&mut self, codehash: String) {
        self.require_owner();
        self.approved_codehashes.insert(codehash);
    }

    // Remove a codehash from the approved list
    pub fn remove_codehash(&mut self, codehash: String) {
        self.require_owner();
        self.approved_codehashes.remove(&codehash);
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
}
