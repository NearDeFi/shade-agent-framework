use crate::*;
use near_sdk::ext_contract;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub enum Payload {
    Ecdsa(String),
    Eddsa(String),
}

#[derive(Debug, Serialize)]
pub struct SignRequest {
    pub payload_v2: Payload,
    pub path: String,
    pub domain_id: u64,
}

#[allow(dead_code)]
#[ext_contract(mpc_contract)]
trait MPCContract {
    fn sign(&self, request: SignRequest);
}

const GAS: Gas = Gas::from_tgas(10);
const ATTACHED_DEPOSIT: NearToken = NearToken::from_yoctonear(1);

#[near]
impl Contract {
    pub(crate) fn internal_request_signature(
        &self,
        path: String,
        payload: String,
        key_type: String,
    ) -> Promise {
        let (payload_v2, domain_id) = match key_type.as_str() {
            "Eddsa" => (Payload::Eddsa(payload), 1),
            _ => (Payload::Ecdsa(payload), 0),
        };

        let request = SignRequest {
            payload_v2,
            path,
            domain_id,
        };

        mpc_contract::ext(self.mpc_contract_id.clone())
            .with_static_gas(GAS)
            .with_attached_deposit(ATTACHED_DEPOSIT)
            .sign(request)
    }
}
