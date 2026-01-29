use crate::*;

#[near]
impl Contract {
    // Get whether the contract requires TEE for registration
    pub fn get_requires_tee(&self) -> bool {
        self.requires_tee
    }

    // Get the list of approved PPIDs
    pub fn get_approved_ppids(&self) -> Vec<Ppid> {
        self.approved_ppids.iter().cloned().collect()
    }

    // Get the list of approved measurements (with optional pagination)
    pub fn get_approved_measurements(
        &self,
        from_index: &Option<u32>,
        limit: &Option<u32>,
    ) -> Vec<FullMeasurementsHex> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(self.approved_measurements.len() as u32);

        self.approved_measurements
            .iter()
            .skip(from as usize)
            .take(limit as usize)
            .cloned()
            .collect()
    }

    // Get the details of a registered agent
    pub fn get_agent(&self, account_id: AccountId) -> Option<AgentView> {
        self.agents.get(&account_id).map(|agent| AgentView {
            account_id: account_id.clone(),
            measurements: agent.measurements.clone(),
            measurements_are_approved: self.approved_measurements.contains(&agent.measurements),
            ppid: agent.ppid.clone(),
            ppid_is_approved: self.approved_ppids.contains(&agent.ppid),
        })
    }

    // Get the list of registered agents and their details (with optional pagination)
    pub fn get_agents(&self, from_index: &Option<u32>, limit: &Option<u32>) -> Vec<AgentView> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(self.agents.len() as u32);

        self.agents
            .iter()
            .skip(from as usize)
            .take(limit as usize)
            .map(|(account_id, agent)| AgentView {
                account_id: account_id.clone(),
                measurements: agent.measurements.clone(),
                measurements_are_approved: self.approved_measurements.contains(&agent.measurements),
                ppid: agent.ppid.clone(),
                ppid_is_approved: self.approved_ppids.contains(&agent.ppid),
            })
            .collect()
    }

    // Local only functions

    // Get the list of whitelisted agents for local mode
    pub fn get_whitelisted_agents_for_local(&self) -> Vec<AccountId> {
        if self.requires_tee {
            panic!("Getting whitelisted agents is not supported for TEE");
        }
        self.whitelisted_agents_for_local.iter().cloned().collect()
    }
}
