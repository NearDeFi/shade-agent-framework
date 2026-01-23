use crate::*;

#[near]
impl Contract {
    // Require the caller to be the owner
    pub(crate) fn require_owner(&mut self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "Caller is not the owner"
        );
    }

    // Require the caller to be a registered agent
    pub(crate) fn require_registered_agent(&mut self) {
        let agent = self
            .get_agent(env::predecessor_account_id())
            .expect("Agent not whitelisted");
        let measurements = agent.measurements.unwrap_or_else(|| {
            panic!("Agent not registered");
        });
        // Check the agent is registered with an approved measurements
        require!(
            self.approved_measurements.contains(&measurements),
            "Agent not registered with approved measurements"
        );
    }
}
