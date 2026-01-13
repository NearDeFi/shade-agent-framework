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

    // Get the details of a whitelisted agent
    pub fn get_agent(&self, account_id: AccountId) -> Option<Agent> {
        self.agents.get(&account_id).map(|codehash_opt| {
            let codehash_is_approved = codehash_opt
                .as_ref()
                .map(|codehash| self.approved_codehashes.contains(codehash))
                .unwrap_or(false);
            Agent {
                account_id: account_id.clone(),
                registered: codehash_opt.is_some(),
                whitelisted: true,
                codehash: codehash_opt.clone(),
                codehash_is_approved,
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
            .map(|(account_id, codehash_opt)| {
                let codehash_is_approved = codehash_opt
                    .as_ref()
                    .map(|codehash| self.approved_codehashes.contains(codehash))
                    .unwrap_or(false);
                Agent {
                    account_id: account_id.clone(),
                    registered: codehash_opt.is_some(),
                    whitelisted: true,
                    codehash: codehash_opt.clone(),
                    codehash_is_approved,
                }
            })
            .collect()
    }
}
