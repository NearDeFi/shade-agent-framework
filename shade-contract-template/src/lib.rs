use hex;
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    env::{self, block_timestamp_ms},
    ext_contract,
    json_types::U64,
    log, near, require,
    serde::Serialize,
    serde_json,
    store::{IterableMap, IterableSet},
};
use shade_attestation::{
    attestation::{AcceptedDstackAttestation, DstackAttestation},
    measurements::{FullMeasurements, FullMeasurementsHex, create_mock_full_measurements_hex},
    report_data::ReportData,
    tcb_info::HexBytes,
};

pub use internal::events::Event;
pub use internal::helpers::AgentRemovalReason;
pub use views::{AgentValidity, AgentView, ContractInfo};

mod internal;
mod owner;
pub mod views;
mod your_functions;

pub type Ppid = HexBytes<16>;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub requires_tee: bool,
    pub attestation_expiration_time_ms: u64,
    pub owner_id: AccountId,
    pub mpc_contract_id: AccountId,
    pub approved_measurements: IterableSet<FullMeasurementsHex>,
    pub approved_ppids: IterableSet<Ppid>,
    pub agents: IterableMap<AccountId, Agent>,
    pub whitelisted_agents_for_local: IterableSet<AccountId>,
}

#[near(serializers = [borsh])]
pub struct Agent {
    pub measurements: FullMeasurementsHex,
    pub ppid: Ppid,
    pub valid_until_ms: u64,
}

#[derive(BorshStorageKey)]
#[near]
pub enum StorageKey {
    ApprovedMeasurements,
    ApprovedPpids,
    Agents,
    WhitelistedAgentsForLocal,
}

// Bytes a registered agent occupies; update if you store more data per agent. The shade-agent-js
// default register deposit mirrors this cost (callers may attach more — the excess is refunded).
const STORAGE_BYTES_TO_REGISTER: u128 = 486;

#[near]
impl Contract {
    #[init]
    #[private]
    pub fn new(
        requires_tee: bool,
        attestation_expiration_time_ms: U64,
        owner_id: AccountId,
        mpc_contract_id: AccountId,
    ) -> Self {
        Self {
            requires_tee,
            attestation_expiration_time_ms: attestation_expiration_time_ms.into(),
            owner_id,
            mpc_contract_id, // Set to v1.signer-prod.testnet for testnet, v1.signer for mainnet
            approved_measurements: IterableSet::new(StorageKey::ApprovedMeasurements),
            approved_ppids: IterableSet::new(StorageKey::ApprovedPpids),
            agents: IterableMap::new(StorageKey::Agents),
            whitelisted_agents_for_local: IterableSet::new(StorageKey::WhitelistedAgentsForLocal),
        }
    }

    // Register an agent, this needs to be called by the agent itself
    #[payable]
    pub fn register_agent(&mut self, attestation: DstackAttestation) -> bool {
        let predecessor = env::predecessor_account_id();
        let already_registered = self.agents.get(&predecessor).is_some();

        // New agents cover storage; re-registration reuses the existing slot. Any deposit beyond
        // the cost is refunded, so callers can safely attach more than the minimum.
        let required_deposit = if already_registered {
            NearToken::from_yoctonear(0)
        } else {
            env::storage_byte_cost()
                .checked_mul(STORAGE_BYTES_TO_REGISTER)
                .unwrap()
        };
        let attached = env::attached_deposit();
        require!(
            attached >= required_deposit,
            &format!(
                "Attached deposit must be at least the storage cost {}",
                required_deposit.exact_amount_display()
            )
        );

        // Verify the attestation and get the measurements and PPID for the agent
        let (measurements, ppid, advisory_ids) = self.verify_attestation(attestation);

        let valid_until_ms = block_timestamp_ms() + self.attestation_expiration_time_ms;
        let (advisory_ids_truncated, number_of_advisory_ids) =
            internal::events::summarize_advisory_ids(&advisory_ids);

        Event::AgentRegistered {
            account_id: &predecessor,
            measurements: &measurements,
            ppid: &ppid,
            advisory_ids_truncated,
            number_of_advisory_ids,
            current_time_ms: U64::from(block_timestamp_ms()),
            valid_until_ms: U64::from(valid_until_ms),
        }
        .emit();

        // Register the agent
        self.agents.insert(
            predecessor.clone(),
            Agent {
                measurements,
                ppid,
                valid_until_ms,
            },
        );

        let refund = attached.checked_sub(required_deposit).unwrap();
        if refund > NearToken::from_yoctonear(0) {
            Promise::new(predecessor).transfer(refund).detach();
        }

        true
    }
}
