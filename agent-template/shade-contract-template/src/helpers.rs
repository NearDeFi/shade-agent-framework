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

    // Require the caller to be a valid agent (has approved measurements and PPID)
    pub(crate) fn require_valid_agent(&mut self) {
        // If in local mode additionally check that the agent is whitelisted
        if !self.requires_tee {
            require!(
                self.whitelisted_agents_for_local.contains(&env::predecessor_account_id()),
                "Agent needs to be whitelisted for local mode"
            );
        }
        // Get the agent and check that it is registered with approved measurements and PPID
        let agent = self
            .get_agent(env::predecessor_account_id())
            .expect("Agent not registered");
        require!(
            self.approved_measurements.contains(&agent.measurements),
            "Agent not registered with approved measurements"
        );
        require!(
            self.approved_ppids.contains(&agent.ppid),
            "Agent not registered with approved PPID"
        );
    }
}
