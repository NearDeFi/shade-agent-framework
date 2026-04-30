use crate::tcb_info::HexBytes;
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
#[derive(Debug, Clone, Copy, Serialize, Deserialize, BorshDeserialize, BorshSerialize)]
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

#[serde_as]
#[derive(Debug, Clone, Copy, Serialize, Deserialize, BorshSerialize, BorshDeserialize)]
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

/// Hex-compatible version of Measurements that deserializes from hex strings.
#[serde_as]
#[derive(
    Debug,
    Clone,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
    Serialize,
    Deserialize,
    BorshSerialize,
    BorshDeserialize,
)]
pub struct MeasurementsHex {
    /// MRTD (Measurement of Root of Trust for Data) - identifies the virtual firmware.
    pub mrtd: HexBytes<48>,
    /// RTMR0 (Runtime Measurement Register 0) - typically measures the bootloader, virtual
    /// firmware data, and configuration.
    pub rtmr0: HexBytes<48>,
    /// RTMR1 (Runtime Measurement Register 1) - typically measures the OS kernel, boot parameters,
    /// and initrd (initial ramdisk).
    pub rtmr1: HexBytes<48>,
    /// RTMR2 (Runtime Measurement Register 2) - typically measures the OS application.
    pub rtmr2: HexBytes<48>,
}

impl From<MeasurementsHex> for Measurements {
    fn from(hex: MeasurementsHex) -> Self {
        Self {
            mrtd: *hex.mrtd,
            rtmr0: *hex.rtmr0,
            rtmr1: *hex.rtmr1,
            rtmr2: *hex.rtmr2,
        }
    }
}

impl From<Measurements> for MeasurementsHex {
    fn from(measurements: Measurements) -> Self {
        Self {
            mrtd: HexBytes::from(measurements.mrtd),
            rtmr0: HexBytes::from(measurements.rtmr0),
            rtmr1: HexBytes::from(measurements.rtmr1),
            rtmr2: HexBytes::from(measurements.rtmr2),
        }
    }
}

/// Hex-compatible version of FullMeasurements that deserializes from hex strings.
#[serde_as]
#[derive(
    Debug,
    Clone,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
    Serialize,
    Deserialize,
    BorshSerialize,
    BorshDeserialize,
)]
pub struct FullMeasurementsHex {
    /// Expected RTMRs (Runtime Measurement Registers).
    pub rtmrs: MeasurementsHex,
    /// Expected digest for the key-provider event.
    pub key_provider_event_digest: HexBytes<48>,

    /// Expected app_compose hash payload.
    pub app_compose_hash_payload: HexBytes<32>,
}

/// Produces mock full measurements (all zeros) for tests
pub fn create_mock_full_measurements_hex() -> FullMeasurementsHex {
    FullMeasurementsHex {
        rtmrs: MeasurementsHex {
            mrtd: HexBytes::from([0; 48]),
            rtmr0: HexBytes::from([0; 48]),
            rtmr1: HexBytes::from([0; 48]),
            rtmr2: HexBytes::from([0; 48]),
        },
        key_provider_event_digest: HexBytes::from([0; 48]),
        app_compose_hash_payload: HexBytes::from([0; 32]),
    }
}

impl From<FullMeasurementsHex> for FullMeasurements {
    fn from(hex: FullMeasurementsHex) -> Self {
        Self {
            rtmrs: hex.rtmrs.into(),
            key_provider_event_digest: *hex.key_provider_event_digest,
            app_compose_hash_payload: *hex.app_compose_hash_payload,
        }
    }
}

impl From<FullMeasurements> for FullMeasurementsHex {
    fn from(measurements: FullMeasurements) -> Self {
        Self {
            rtmrs: measurements.rtmrs.into(),
            key_provider_event_digest: HexBytes::from(measurements.key_provider_event_digest),
            app_compose_hash_payload: HexBytes::from(measurements.app_compose_hash_payload),
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

#[cfg(test)]
mod tests {
    use super::*;
    use borsh::{BorshDeserialize, BorshSerialize};

    fn sample() -> FullMeasurements {
        FullMeasurements {
            rtmrs: Measurements {
                mrtd: [0x10; 48],
                rtmr0: [0x20; 48],
                rtmr1: [0x30; 48],
                rtmr2: [0x40; 48],
            },
            key_provider_event_digest: [0x50; 48],
            app_compose_hash_payload: [0x60; 32],
        }
    }

    // FullMeasurements → FullMeasurementsHex → FullMeasurements is identity.
    #[test]
    fn full_measurements_hex_round_trip_is_identity() {
        let original = sample();
        let hex: FullMeasurementsHex = original.into();
        let back: FullMeasurements = hex.into();
        assert_eq!(back.rtmrs.mrtd, original.rtmrs.mrtd);
        assert_eq!(back.rtmrs.rtmr0, original.rtmrs.rtmr0);
        assert_eq!(back.rtmrs.rtmr1, original.rtmrs.rtmr1);
        assert_eq!(back.rtmrs.rtmr2, original.rtmrs.rtmr2);
        assert_eq!(back.key_provider_event_digest, original.key_provider_event_digest);
        assert_eq!(back.app_compose_hash_payload, original.app_compose_hash_payload);
    }

    // Borsh serialize → deserialize preserves all fields.
    #[test]
    fn full_measurements_borsh_round_trip_preserves_all_fields() {
        let original = sample();
        let bytes = borsh::to_vec(&original).expect("serialize");
        let back = FullMeasurements::try_from_slice(&bytes).expect("deserialize");
        assert_eq!(back.rtmrs.mrtd, original.rtmrs.mrtd);
        assert_eq!(back.rtmrs.rtmr0, original.rtmrs.rtmr0);
        assert_eq!(back.rtmrs.rtmr1, original.rtmrs.rtmr1);
        assert_eq!(back.rtmrs.rtmr2, original.rtmrs.rtmr2);
        assert_eq!(back.key_provider_event_digest, original.key_provider_event_digest);
        assert_eq!(back.app_compose_hash_payload, original.app_compose_hash_payload);
    }

    // create_mock_full_measurements_hex returns the documented zero-filled shape.
    #[test]
    fn mock_full_measurements_hex_is_all_zero() {
        let mock = create_mock_full_measurements_hex();
        assert_eq!(*mock.rtmrs.mrtd, [0u8; 48]);
        assert_eq!(*mock.rtmrs.rtmr0, [0u8; 48]);
        assert_eq!(*mock.rtmrs.rtmr1, [0u8; 48]);
        assert_eq!(*mock.rtmrs.rtmr2, [0u8; 48]);
        assert_eq!(*mock.key_provider_event_digest, [0u8; 48]);
        assert_eq!(*mock.app_compose_hash_payload, [0u8; 32]);
    }
}
