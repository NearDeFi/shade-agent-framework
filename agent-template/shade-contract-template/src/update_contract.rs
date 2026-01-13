use crate::*;

#[near]
impl Contract {
    // Function to update the contract code
    // Review https://docs.near.org/smart-contracts/release/upgrade for more details
    pub fn update_contract(&mut self) -> Promise {
        self.require_owner();

        let code = env::input().expect("Error: No input").to_vec();

        Promise::new(env::current_account_id())
            .deploy_contract(code)
            .function_call(
                "migrate".to_string(),
                b"".to_vec(),
                NearToken::from_near(0),
                Gas::from_tgas(10),
            )
            .as_return()
    }
}
