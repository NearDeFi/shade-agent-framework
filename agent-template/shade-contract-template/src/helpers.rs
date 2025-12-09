use crate::*;

#[near]
impl Contract {
    // Require the caller to be the owner
    pub(crate) fn require_owner(&mut self) {
        require!(env::predecessor_account_id() == self.owner_id, "Caller is not the owner");
    }

    // Require the caller to have a verified agent
    pub(crate) fn require_verified_agent(&mut self) {
        let agent = self
            .get_agent(env::predecessor_account_id())
            .expect("Agent not whitelisted");
        if self.requires_tee {
            let codehash = agent.codehash.unwrap_or_else(|| {
                panic!("Agent not registered");
            });
            require!(self.approved_codehashes.contains(&codehash));
        }
    }
}