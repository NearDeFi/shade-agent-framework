# tests-in-tee

Integration tests that run inside a TEE (Phala). They test shade-agent-js, shade-contract-template, and shade-attestation with real TEE attestations. The test script runs outside the TEE: it deploys the contract and test image, configures measurements and PPIDs, then calls endpoints on the app and verifies results.

## Running the tests

- Before testing, install dependencies and build libraries

  In the shade-agent-framework root

  ```bash
  cd shade-agent-cli
  npm i
  cd ../shade-agent-js
  npm i
  npm run build
  cd ../tests-in-tee
  npm i
  cd test-image
  npm i
  cd ../..
  ```

- Build the contract

  In the shade-agent-framework root

  Linux

  ```bash
  cd shade-contract-template
  cargo near build non-reproducible-wasm --no-abi
  ```

  Mac

  ```bash
  docker run --rm \
  -v "$(pwd)":/workspace \
  -w "/workspace/shade-contract-template" \
  pivortex/near-builder@sha256:cdffded38c6cff93a046171269268f99d517237fac800f58e5ad1bcd8d6e2418 \
  cargo near build non-reproducible-wasm --no-abi
  ```

- Fill out environment variables

  Inside ./tests-in-tee fill out an env file

  ```env
  TESTNET_ACCOUNT_ID=
  TESTNET_PRIVATE_KEY=
  SPONSOR_ACCOUNT_ID=
  SPONSOR_PRIVATE_KEY=
  PHALA_API_KEY=
  ```

  TESTNET and SPONSOR can be the same; make sure the account has at least 20 testnet NEAR.

- Run the tests

  In the shade-agent-framework root

  ```bash
  cd tests-in-tee
  npm run test
  ```

## Tests

| Test                          | What it tests                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `successful-registration`     | With correct measurements and PPID approved by the owner, the agent registers and then calls request_signature to confirm it is verified and can sign. the script checks there are no registration or call errors and that the agent appears as registered on the contract.                                                                                                      |
| `wrong-measurements-rtmr2`    | Registration fails when the owner has approved measurements that use a wrong RTMR2 value, so attestation does not match. The TEE then calls request_signature to check if the agent is not verified; the script checks the agent is not registered (the call returns "Agent not registered") and that the registration error mentions wrong expected_measurements hash.          |
| `wrong-key-provider`          | Registration fails when the approved measurements use a wrong key provider digest. The TEE then calls request_signature to check if the agent is not verified; the script checks the agent is not registered (the call returns "Agent not registered") and that the registration error matches the expected expected_measurements behavior.                                      |
| `wrong-app-compose`           | Registration fails when the approved measurements use a wrong app compose hash (e.g. from a different set of env vars). The TEE then calls request_signature to check if the agent is not verified; the script checks the agent is not registered (the call returns "Agent not registered") and that errors match the expected_measurements behavior.                            |
| `wrong-ppid`                  | Registration fails when the owner has approved a PPID that does not match the TEE’s PPID. The TEE then calls request_signature to check if the agent is not verified; the script checks the agent is not registered (the call returns "Agent not registered") and that the registration error indicates the PPID is not in the allowed list.                                     |
| `different-account-id`        | Attestation is tied to the agent’s account ID (report data). This test verifies that when the attestation’s report data does not match the predecessor, registration fails with a wrong report_data hash error. The TEE then calls request_signature to check if the agent is verified; the script checks the agent is not registered (the call returns "Agent not registered"). |
| `measurements-removed`        | After the agent registers successfully, the owner removes the approved measurements. The TEE then calls request_signature to check the agent is no longer verified; the script checks the call fails with InvalidMeasurements and that the agent is removed from the contract’s agent map.                                                                                       |
| `ppid-removed`                | After the agent registers successfully, the owner removes the approved PPID. The TEE then calls request_signature to check if the agent is verified; the script checks the call fails with InvalidPpid and that the agent is removed from the contract’s agent map.                                                                                                              |
| `unique-keys`                 | Two agent instances are created and each derives keys. The test verifies that each instance has the expected number of keys and that all keys are unique across instances (no key reuse).                                                                                                                                                                                        |
| `attestation-expired`         | The contract’s attestation expiration is set to 10 seconds. The TEE registers, waits 12 seconds, then calls request_signature to check if the agent is verified; the script checks the call fails with ExpiredAttestation and that the agent is removed from the contract’s agent map.                                                                                           |
| `full-operations-with-errors` | Runs the full set of ShadeClient operations (create, fund, register, view, balance, getAttestation, isWhitelisted, call, getPrivateKeys) and checks that intentional errors occur as expected (e.g. funding with 1M NEAR fails, calling a nonexistent method fails). It is done to check no private key material appears in console output or in the HTTP response.              |
