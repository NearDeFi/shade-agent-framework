#![no_std]
#![deny(clippy::mod_module_files)]

extern crate alloc;

// dcap-qvl requires getrandom but NEAR vm doesn't support it
// error if randomness is called
#[cfg(target_arch = "wasm32")]
mod wasm_getrandom {
    use getrandom::{Error, register_custom_getrandom};

    fn randomness_unsupported(_: &mut [u8]) -> Result<(), Error> {
        Err(Error::UNSUPPORTED)
    }

    register_custom_getrandom!(randomness_unsupported);
}

pub mod app_compose;
pub mod attestation;
pub mod collateral;
pub mod measurements;
pub mod quote;
pub mod report_data;
pub mod tcb_info;
