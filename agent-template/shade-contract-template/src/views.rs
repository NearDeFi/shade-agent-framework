use crate::*;

#[near]
impl Contract {
    // Get whether the contract requires TEE for registration
    pub fn get_requires_tee(&self) -> bool {
        self.requires_tee.clone()
    }

    // Get the list of approved codehashes
    pub fn get_approved_codehashes(
        &self,
        from_index: &Option<u32>,
        limit: &Option<u32>,
    ) -> Vec<FullMeasurements> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(self.approved_measurements.len() as u32);

        self.approved_measurements
            .iter()
            .skip(from as usize)
            .take(limit as usize)
            .map(|measurements| measurements.clone())
            .collect()
    }

    // Get the details of a whitelisted agent
    pub fn get_agent(&self, account_id: AccountId) -> Option<Agent> {
        self.agents.get(&account_id).map(|measurements_opt| {
            let measurements_are_approved = measurements_opt
                .as_ref()
                .map(|measurements| self.approved_measurements.contains(measurements))
                .unwrap_or(false);
            Agent {
                account_id: account_id.clone(),
                registered: measurements_opt.is_some(),
                whitelisted: true,
                measurements: measurements_opt.clone(),
                measurements_are_approved,
            }
        })
    }

    // Get the list of whitelisted agents and their details
    pub fn get_agents(&self, from_index: &Option<u32>, limit: &Option<u32>) -> Vec<Agent> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(self.agents.len() as u32);

        self.agents
            .iter()
            .skip(from as usize)
            .take(limit as usize)
            .map(|(account_id, measurements_opt)| {
                let measurements_are_approved = measurements_opt
                .as_ref()
                .map(|measurements| self.approved_measurements.contains(measurements))
                .unwrap_or(false);
            Agent {
                account_id: account_id.clone(),
                registered: measurements_opt.is_some(),
                whitelisted: true,
                measurements: measurements_opt.clone(),
                measurements_are_approved,
                }
            })
            .collect()
    }
}
