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

    // Require the caller to be a valid agent or it is removed from the agents map
    // Just because an agent is registered does not mean it is currently valid
    // Returns Some(Promise) if agent is invalid (to fail the request), None if valid
    pub(crate) fn require_valid_agent(&mut self) -> Option<Promise> {
        let account_id = env::predecessor_account_id();

        // Extract agent data and check if it is registered
        let (measurements, ppid, valid_until_ms) = match self.agents.get(&account_id) {
            Some(agent) => (
                agent.measurements.clone(),
                agent.ppid.clone(),
                agent.valid_until_ms,
            ),
            None => {
                panic!("Agent not registered");
            }
        };

        // Check if the agent has approved measurements, PPID and is not expired
        let mut reasons = Vec::new();
        if valid_until_ms < block_timestamp_ms() {
            reasons.push(AgentRemovalReason::ExpiredAttestation);
        }
        if !self.approved_measurements.contains(&measurements) {
            reasons.push(AgentRemovalReason::InvalidMeasurements);
        }
        if !self.approved_ppids.contains(&ppid) {
            reasons.push(AgentRemovalReason::InvalidPpid);
        }

        // If in local mode additionally check that the agent is whitelisted
        if !self.requires_tee {
            if !self.whitelisted_agents_for_local.contains(&account_id) {
                reasons.push(AgentRemovalReason::NotWhitelistedForLocal);
            }
        }

        // If there are reasons to remove the agent, remove it and make a cross contract call to fail in the next block
        if !reasons.is_empty() {
            self.agents.remove(&account_id);
            Event::AgentRemoved {
                account_id: &account_id,
                reasons: reasons.clone(),
            }
            .emit();
            let args_json = serde_json::json!({
                "reasons": reasons
            });
            let promise = Promise::new(env::current_account_id()).function_call(
                "fail_on_invalid_agent".to_string(),
                serde_json::to_vec(&args_json).expect("Failed to serialize reasons"),
                NearToken::from_near(0),
                Gas::from_tgas(10),
            );
            return Some(promise);
        }
        None
    }

    #[private]
    pub fn fail_on_invalid_agent(reasons: Vec<AgentRemovalReason>) {
        env::panic_str(&format!("Invalid agent: {:?}", reasons));
    }
}
