# Integration Tests in TEE

This directory contains integration tests that run in a Trusted Execution Environment (TEE) on Phala Cloud.

## Structure

- `test-script.js` - Script that runs outside the TEE, orchestrates tests
- `test-image/` - Docker image that runs inside the TEE, provides test endpoints
- `docker-compose.yaml` - Docker compose configuration for the test image
- `.env.example` - Example environment variables

## Setup

1. Copy `.env.example` to `.env` and fill in the values:
   ```bash
   cp .env.example .env
   ```

2. Install dependencies for the shade-agent-cli (required for test script utilities):
   ```bash
   cd ../shade-agent-cli
   npm install
   cd ../tests-in-tee
   ```

3. Install dependencies for the test image:
   ```bash
   cd test-image
   npm install
   ```

4. Build the test image:
   ```bash
   cd test-image
   npm run build
   ```

5. Make sure you have the Phala CLI installed in `shade-agent-cli/node_modules/.bin/phala`

6. Install dependencies for the test script:
   ```bash
   npm install
   ```

## Running Tests

Run the test script:
```bash
node test-script.js
```

The script will:
1. Set up the contract (approve/remove measurements and PPIDs)
2. Deploy the test image to Phala Cloud
3. Call test endpoints
4. Verify results
5. Report pass/fail status

## Tests

1. **Wrong measurements (RTMR2)** - Can't verify with wrong RTMR2 measurement
2. **Wrong key provider** - Can't verify with wrong key provider digest
3. **Wrong app compose** - Can't verify with wrong app compose hash
4. **Wrong PPID** - Can't verify with wrong PPID
5. **Different account ID** - Can't submit attestation from different account
6. **Measurements removed** - Can't make calls if measurements are removed
7. **PPID removed** - Can't make calls if PPID is removed

## Environment Variables

- `TESTNET_ACCOUNT_ID` - NEAR testnet account that will fund and manage tests
- `TESTNET_PRIVATE_KEY` - Private key for the testnet account
- `PHALA_API_KEY` - Phala Cloud API key for deployment

**Note**: `AGENT_CONTRACT_ID` is automatically generated as `shade-test-contract.${TESTNET_ACCOUNT_ID}` and written to the `.env` file. The script will create this as a subaccount, deploy the contract, and initialize it automatically.
