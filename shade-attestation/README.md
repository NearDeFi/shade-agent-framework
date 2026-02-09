# shade attestation

A repo to verify Dstack TEE attestations. A fork of NEAR One's attestation crate https://github.com/near/mpc/tree/main/crates/attestation.

## What it verifies

Given a Dstack attestation (quote, collateral, and TCB info), a timestamp, expected report data, a set of accepted measurements, and a set of accepted PPIDs, the crate verifies the following.

- **Quote and collateral.** The quote is verified with dcap-qvl at the given timestamp, so the attestation is cryptographically valid and the collateral chain is trusted. 

- **TCB status.** The TCB (Trusted Computing Base) status must be "UpToDate", meaning the measured platform components (CPU microcode, firmware, etc.) match the latest known good values. There must be no outstanding security advisory IDs.

- **Report data.** The report_data in the quote must equal the expected value. This binds the attestation to the correct signer.

- **PPID.** The PPID (Platform Provisioning ID) from the verified quote must be in the list of accepted PPIDs.

- **Measurements.** At least one set of accepted measurements must match. Each set specifies expected values for:
  - **Static RTMRs:** MRTD, RTMR0, RTMR1, and RTMR2 in both the report and the TCB info.
  - **Key-provider event:** The digest of the key-provider event in the RTMR3 event log must match the expected digest.
  - **App compose hash:** The compose-hash in the TCB info (and the corresponding event in the event log) must match the expected app-compose hash payload.

- **RTMR3 and event log.** RTMR3 in the TCB info must match RTMR3 in the report. The event log is replayed (events with the Dstack event type in RTMR3 are hashed in order), and the resulting digest must match the report’s RTMR3. The compose-hash and key-provider events must each appear exactly once.

If all checks pass, the crate returns the matching full measurements and the verified PPID.

## Changes from NEAR One implementation 

### PPID verification 

The library additionally checks the PPID of the device in the verified quote matches the expected PPID provided.

### App compose hash verification 

The app compose hash has been added to the list of expected measurements. 

There are no checks on specific values of the app compose, developers can have whatever app compose they want as long as it matches the expected app compose hash.

### Returning the measurements and PPID

The measurements and PPID are returned from the verify function.

### Hex implementation of measurements 

There is a hex implementation of the measurements structs for easier identification.

### Defaults 

There is a default implementation of the measurements structs and HexBytes for easier mocking of attestations and PPID.