# Notice for internal audit

## Smart contract and attestation crate

The main things to check for is that:

- An agent cannot register if it does not have the correct measurement and running the correct code (rtmr0-2, mrtd, correct app compose and key provider), PPID and the attestation is sent by the same account id as the one contained within the TEE instance that generated the attestation. Does anything else need to be measured and validated?
- Think about can someone deploy the smart contract on top of the account with existing state to have an agent registered that did not pass the attestations. Do we put restrictions in place for this or it is sufficient for a contract to be verified by checking the accounts past history?

[Contract](./agent-template/shade-contract-template/)

[attestation crate](./shade-attestation/)

[Attestation crate diff from near one implementation](https://github.com/PiVortex/mpc/commit/91ccef64aef738fddebc1a62fab64f55092e0486)

## API

The main thing to check is:

- All keys for an agent running in a TEE has randomly generated private keys, if keys are not randomly generated it should not be able to provide a real attestation.
- Private keys are not leaked from the TEE by accident. For example a function call failing and NAJ emitting the private key
- Previous keys can not be recovered if code is updated, new code should = fresh keys.

[API](./shade-agent-js/)
