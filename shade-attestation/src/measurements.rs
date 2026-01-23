use alloc::string::String;
use borsh::{BorshDeserialize, BorshSerialize};
use serde::{Deserialize, Serialize};
use serde_with::{Bytes, serde_as};

/// Required measurements for TEE attestation verification (a.k.a. RTMRs checks). These values
/// define the trusted baseline that TEE environments must match during verification. They
/// should be updated when the underlying TEE environment changes.
///
/// To learn more about the RTMRs, see:
/// - https://docs.phala.network/phala-cloud/tees-attestation-and-zero-trust-security/attestation#runtime-measurement-fields
/// - https://arxiv.org/pdf/2303.15540 (Section 9.1)
#[serde_as]
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, BorshDeserialize, BorshSerialize)]
pub struct Measurements {
    /// MRTD (Measurement of Root of Trust for Data) - identifies the virtual firmware.
    #[serde_as(as = "Bytes")]
    pub mrtd: [u8; 48],
    /// RTMR0 (Runtime Measurement Register 0) - typically measures the bootloader, virtual
    /// firmware data, and configuration.
    #[serde_as(as = "Bytes")]
    pub rtmr0: [u8; 48],
    /// RTMR1 (Runtime Measurement Register 1) - typically measures the OS kernel, boot parameters,
    /// and initrd (initial ramdisk).
    #[serde_as(as = "Bytes")]
    pub rtmr1: [u8; 48],
    /// RTMR2 (Runtime Measurement Register 2) - typically measures the OS application.
    #[serde_as(as = "Bytes")]
    pub rtmr2: [u8; 48],
}

impl Default for Measurements {
    fn default() -> Self {
        Self {
            mrtd: [0; 48],
            rtmr0: [0; 48],
            rtmr1: [0; 48],
            rtmr2: [0; 48],
        }
    }
}

#[serde_as]
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
pub struct FullMeasurements {
    /// Expected RTMRs (Runtime Measurement Registers).
    pub rtmrs: Measurements,
    /// Expected digest for the key-provider event.
    #[serde_as(as = "Bytes")]
    pub key_provider_event_digest: [u8; 48],

    /// Expected app_compose hash payload.
    #[serde_as(as = "Bytes")]
    pub app_compose_hash_payload: [u8; 32],
}

impl Default for FullMeasurements {
    fn default() -> Self {
        Self {
            rtmrs: Measurements::default(),
            key_provider_event_digest: [0; 48],
            app_compose_hash_payload: [0; 32],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MeasurementsError {
    #[error("no TD10 report")]
    NoTd10Report,
    #[error("invalid TCB info")]
    InvalidTcbInfo,
    #[error("invalid hex value for {0}: {1}")]
    InvalidHexValue(String, String),
    #[error("invalid length for {0}: {1}")]
    InvalidLength(String, usize),
}

impl TryFrom<dcap_qvl::verify::VerifiedReport> for Measurements {
    type Error = MeasurementsError;

    fn try_from(verified_report: dcap_qvl::verify::VerifiedReport) -> Result<Self, Self::Error> {
        let td10 = verified_report
            .report
            .as_td10()
            .ok_or(MeasurementsError::NoTd10Report)?;
        Ok(Self {
            rtmr0: td10.rt_mr0,
            rtmr1: td10.rt_mr1,
            rtmr2: td10.rt_mr2,
            mrtd: td10.mr_td,
        })
    }
}
