use hex::{decode, encode};
use near_sdk::{
    env::{self, block_timestamp},
    near, require,
    store::{IterableMap, IterableSet},
    AccountId, Gas, NearToken, PanicOnDefault, Promise,
};
use dcap_qvl::{verify, QuoteCollateralV3};

mod chainsig;
mod collateral;

pub type Codehash = String;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub owner_id: AccountId,
    pub approved_codehashes: IterableSet<Codehash>,
    pub agents: IterableMap<AccountId, Option<Codehash>>,
    pub requires_tee: bool,
}

#[near(serializers = [json])]
pub struct Attestation {
    quote_hex: String,
    collateral: String,
    checksum: String,
    tcb_info: String,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct Agent {
    account_id: AccountId,
    verified: bool,
    whitelisted: bool,
    codehash: Option<Codehash>,
}

#[near]
impl Contract {
    #[init]
    #[private]
    pub fn init(owner_id: AccountId, requires_tee: bool) -> Self {
        Self {
            owner_id,
            approved_codehashes: IterableSet::new(b"a"),
            agents: IterableMap::new(b"b"),
            requires_tee,
        }
    }

    // Register an agent, this need to be called by the agent itself
    pub fn register_agent(
        &mut self,
        attestation: Attestation,
    ) -> bool {
        // Check that the agent is whitelisted and not already registered
        let codehash_opt = self.agents.get(&env::predecessor_account_id())
            .expect("Agent needs to be whitelisted first");
        require!(codehash_opt.is_none(), "Agent already registered");

        if self.requires_tee {
            // Verify the attestation and get the codehash from the agent
            let codehash = collateral::verify_attestation(attestation);

            // Verify the codehash is approved
            require!(self.approved_codehashes.contains(&codehash));

            // Register the agent with the codehash
            self.agents.insert(env::predecessor_account_id(), Some(codehash));
        } else {
            // Register the agent without TEE verification
            self.agents.insert(env::predecessor_account_id(), Some("not-in-a-tee".to_string()));
        }

        true
    }

    // Request a signature from the contract
    pub fn request_signature(
        &mut self,
        path: String,
        payload: String,
        key_type: String,
    ) -> Promise {
        self.require_approved_codehash();

        chainsig::internal_request_signature(path, payload, key_type)
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
        self.agents.insert(account_id, None);
    }

    // Remove an agent from the list of agents
    pub fn remove_agent(&mut self, account_id: AccountId) {
        self.require_owner();
        self.agents.remove(&account_id);
    }

    // View methods

    // Get the details of an agent
    pub fn get_agent(&self, account_id: AccountId) -> Option<Agent> {
        self.agents.get(&account_id).map(|codehash_opt| {
            Agent {
                account_id: account_id.clone(),
                verified: codehash_opt.is_some(),
                whitelisted: true, 
                codehash: codehash_opt.clone(),
            }
        })
    }

    // Get if the contract requires TEE verification
    pub fn get_requires_tee(&self) -> bool {
        self.requires_tee
    }

    // Get the list of approved codehashes
    pub fn get_approved_codehashes(
        &self,
        from_index: &Option<u32>,
        limit: &Option<u32>,
    ) -> Vec<String> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(self.approved_codehashes.len() as u32);
        
        self.approved_codehashes
            .iter()
            .skip(from as usize)
            .take(limit as usize)
            .map(|codehash| codehash.clone())
            .collect()
    }

    // Get the list of agents
    pub fn get_agents(
        &self,
        from_index: &Option<u32>,
        limit: &Option<u32>,
    ) -> Vec<Agent> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(self.agents.len() as u32);
        
        self.agents
            .iter()
            .skip(from as usize)
            .take(limit as usize)
            .map(|(account_id, codehash_opt)| {
                Agent {
                    account_id: account_id.clone(),
                    verified: codehash_opt.is_some(),
                    whitelisted: true,
                    codehash: codehash_opt.clone(),
                }
            })
            .collect()
    }

    // Helper methods

    // Require the caller to be the owner
    fn require_owner(&mut self) {
        require!(env::predecessor_account_id() == self.owner_id);
    }

    // Require the caller to have a codehash in the approved list if TEE is required
    fn require_approved_codehash(&mut self) {
        if self.requires_tee {
            let agent = self.get_agent(env::predecessor_account_id())
                .expect("Agent not whitelisted");
            let codehash = agent.codehash.unwrap_or_else(|| {
                panic!("Agent not registered");
            });
            require!(self.approved_codehashes.contains(&codehash));
        }
    }
}
