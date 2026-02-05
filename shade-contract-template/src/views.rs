use crate::*;

#[near(serializers = [json])]
pub struct ContractInfo {
    pub requires_tee: bool,
    pub attestation_expiration_time_ms: U64,
    pub owner_id: AccountId,
    pub mpc_contract_id: AccountId,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct AgentView {
    pub account_id: AccountId,
    pub measurements: FullMeasurementsHex,
    pub measurements_are_approved: bool,
    pub ppid: Ppid,
    pub ppid_is_approved: bool,
    pub valid_until_ms: U64,
    pub timestamp_is_valid: bool,
    pub is_valid: bool,
}

#[near]
impl Contract {
    // Get whether the contract requires TEE for registration
    pub fn get_contract_info(&self) -> ContractInfo {
        ContractInfo {
            requires_tee: self.requires_tee,
            attestation_expiration_time_ms: U64::from(self.attestation_expiration_time_ms),
            owner_id: self.owner_id.clone(),
            mpc_contract_id: self.mpc_contract_id.clone(),
        }
    }

    // Get the list of approved PPIDs
    pub fn get_approved_ppids(&self) -> Vec<Ppid> {
        self.approved_ppids.iter().cloned().collect()
    }

    // Get the list of approved measurements
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
            valid_until_ms: U64::from(agent.valid_until_ms),
            timestamp_is_valid: agent.valid_until_ms > block_timestamp_ms(),
            is_valid: self.approved_measurements.contains(&agent.measurements)
                && self.approved_ppids.contains(&agent.ppid)
                && agent.valid_until_ms > block_timestamp_ms(),
        })
    }

    // Get the list of registered agents and their details
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
                valid_until_ms: U64::from(agent.valid_until_ms),
                timestamp_is_valid: agent.valid_until_ms > block_timestamp_ms(),
                is_valid: self.approved_measurements.contains(&agent.measurements)
                    && self.approved_ppids.contains(&agent.ppid)
                    && agent.valid_until_ms > block_timestamp_ms(),
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
