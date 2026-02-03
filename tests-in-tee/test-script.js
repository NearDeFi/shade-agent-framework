#!/usr/bin/env node

/**
 * Test script that runs outside the TEE
 * Orchestrates tests by:
 * 1. Setting up contract (approving/removing measurements and PPIDs)
 * 2. Deploying to Phala
 * 3. Calling test endpoints
 * 4. Verifying results
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { parse, stringify } from 'yaml';
import { platform } from 'os';
import { Account } from '@near-js/accounts';
import { KeyPairSigner } from '@near-js/signers';
import { JsonRpcProvider } from '@near-js/providers';
import { NEAR } from '@near-js/tokens';
import { getMeasurements, calculateAppComposeHash, extractAllowedEnvs } from '../shade-agent-cli/src/utils/measurements.js';
import { getPpids } from '../shade-agent-cli/src/utils/ppids.js';
import { tgasToGas } from '../shade-agent-cli/src/utils/near.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from .env file
const envPath = resolve(__dirname, '.env');
dotenv.config({ path: envPath });

// Load environment variables
const TESTNET_ACCOUNT_ID = process.env.TESTNET_ACCOUNT_ID;
const TESTNET_PRIVATE_KEY = process.env.TESTNET_PRIVATE_KEY;
const PHALA_API_KEY = process.env.PHALA_API_KEY;

if (!TESTNET_ACCOUNT_ID || !TESTNET_PRIVATE_KEY || !PHALA_API_KEY) {
  console.error('Missing required environment variables:');
  console.error('  TESTNET_ACCOUNT_ID');
  console.error('  TESTNET_PRIVATE_KEY');
  console.error('  PHALA_API_KEY');
  process.exit(1);
}

// Generate contract ID as subaccount of TESTNET_ACCOUNT_ID
const AGENT_CONTRACT_ID = `shade-test-contract.${TESTNET_ACCOUNT_ID}`;
const TEST_APP_NAME = 'shade-integration-tests';

// Toggle to skip redeploying account, contract, and initialization (useful for reusing existing deployment)
const SKIP_CONTRACT_DEPLOYMENT = true

// Write AGENT_CONTRACT_ID to .env file for docker-compose
function updateEnvFile() {
  const envPath = resolve(__dirname, '.env');
  let envContent = '';
  
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  }
  
  // Update or add AGENT_CONTRACT_ID
  const lines = envContent.split('\n');
  let found = false;
  const updatedLines = lines.map(line => {
    if (line.startsWith('AGENT_CONTRACT_ID=')) {
      found = true;
      return `AGENT_CONTRACT_ID=${AGENT_CONTRACT_ID}`;
    }
    return line;
  });
  
  if (!found) {
    updatedLines.push(`AGENT_CONTRACT_ID=${AGENT_CONTRACT_ID}`);
  }
  
  // Also ensure SPONSOR_ACCOUNT_ID and SPONSOR_PRIVATE_KEY are set
  let sponsorAccountFound = false;
  let sponsorPrivateKeyFound = false;
  const finalLines = updatedLines.map(line => {
    if (line.startsWith('SPONSOR_ACCOUNT_ID=')) {
      sponsorAccountFound = true;
      return `SPONSOR_ACCOUNT_ID=${TESTNET_ACCOUNT_ID}`;
    }
    if (line.startsWith('SPONSOR_PRIVATE_KEY=')) {
      sponsorPrivateKeyFound = true;
      return `SPONSOR_PRIVATE_KEY=${TESTNET_PRIVATE_KEY}`;
    }
    return line;
  });
  
  if (!sponsorAccountFound) {
    finalLines.push(`SPONSOR_ACCOUNT_ID=${TESTNET_ACCOUNT_ID}`);
  }
  if (!sponsorPrivateKeyFound) {
    finalLines.push(`SPONSOR_PRIVATE_KEY=${TESTNET_PRIVATE_KEY}`);
  }
  
  fs.writeFileSync(envPath, finalLines.join('\n') + '\n');
  console.log(`✓ Updated .env file with AGENT_CONTRACT_ID=${AGENT_CONTRACT_ID}`);
}

// Initialize NEAR account
const provider = new JsonRpcProvider(
  {
      url: "https://test.rpc.fastnear.com"
  },
  {
      retries: 3,
      backoff: 2,
      wait: 1000,
  }
  );

const signer = KeyPairSigner.fromSecretKey(TESTNET_PRIVATE_KEY);
const account = new Account(TESTNET_ACCOUNT_ID, provider, signer);
const contractAccount = new Account(AGENT_CONTRACT_ID, provider, signer);

// Sleep helper
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Create contract account (as subaccount of TESTNET_ACCOUNT_ID)
async function createContractAccount() {
  console.log('Creating contract account...');
  const fundingAmount = 10; // NEAR tokens
  
  // Check if master account has enough balance
  const requiredBalance = fundingAmount + 0.1;
  const masterBalance = await account.getBalance(NEAR);
  const masterBalanceDecimal = parseFloat(NEAR.toDecimal(masterBalance));
  
  // Get contract account balance if it exists (will be returned to master when deleted)
  let contractAccountExists = false;
  let contractBalanceDecimal = 0;
  try {
    const state = await contractAccount.getState();
    contractAccountExists = true;
    // Extract balance from state
    if (state && state.balance && state.balance.total) {
      const contractBalance = state.balance.total;
      contractBalanceDecimal = parseFloat(NEAR.toDecimal(contractBalance));
    }
  } catch (e) {
    // Contract account doesn't exist, balance is 0 - this is fine
    if (e.type !== 'AccountDoesNotExist') {
      throw new Error(`Error checking contract account: ${e.message}`);
    }
  }
  
  const totalBalance = masterBalanceDecimal + contractBalanceDecimal;
  
  if (totalBalance < requiredBalance) {
    throw new Error(
      `Insufficient balance. Master account has ${totalBalance} NEAR but needs ${requiredBalance} NEAR ` +
      `(${fundingAmount} NEAR for contract + 0.1 NEAR for fees)`
    );
  }
  
  // Delete the contract account if it exists
  if (contractAccountExists) {
    console.log('Contract account already exists, deleting it...');
    try {
      await contractAccount.deleteAccount(TESTNET_ACCOUNT_ID);
      await sleep(2000);
    } catch (deleteError) {
      if (deleteError.type === 'AccessKeyDoesNotExist') {
        throw new Error(
          'Cannot delete contract account - access key mismatch. ' +
          'The contract account was created with a different master account.'
        );
      }
      throw new Error(`Failed to delete existing contract account: ${deleteError.message}`);
    }
  } else {
    console.log('Contract account does not exist, creating it');
  }
  
  // Create the contract account
  try {
    const publicKey = await account.getSigner().getPublicKey();
    const result = await account.createAccount(
      AGENT_CONTRACT_ID,
      publicKey,
      NEAR.toUnits(fundingAmount)
    );
    
    await sleep(2000);
    console.log(`✓ Contract account created: ${AGENT_CONTRACT_ID}`);
  } catch (e) {
    throw new Error(`Failed to create contract account: ${e.message}`);
  }
}

// Deploy contract WASM
async function deployContract() {
  console.log('Deploying contract WASM...');
  const wasmPath = resolve(__dirname, '..', 'agent-template', 'shade-contract-template', 'target', 'near', 'shade_contract.wasm');
  
  if (!fs.existsSync(wasmPath)) {
    throw new Error(`WASM file not found at ${wasmPath}. Please build the contract first.`);
  }
  
  try {
    const wasmBytes = fs.readFileSync(wasmPath);
    await contractAccount.deployContract(new Uint8Array(wasmBytes));
    await sleep(2000);
    console.log('✓ Contract deployed');
  } catch (e) {
    throw new Error(`Failed to deploy contract: ${e.message}`);
  }
}

// Initialize contract
async function initializeContract() {
  console.log('Initializing contract...');
  
  const initArgs = {
    owner_id: TESTNET_ACCOUNT_ID,
    mpc_contract_id: 'v1.signer-prod.testnet', // testnet MPC contract
    requires_tee: true,
  };
  
  try {
    await contractAccount.callFunction({
      contractId: AGENT_CONTRACT_ID,
      methodName: 'new',
      args: initArgs,
      gas: tgasToGas(30),
    });
    await sleep(2000);
    console.log('✓ Contract initialized');
  } catch (e) {
    throw new Error(`Failed to initialize contract: ${e.message}`);
  }
}

// Get sudo prefix for Docker commands based on OS
function getSudoPrefix() {
  const platformName = platform();
  return platformName === 'linux' ? 'sudo ' : '';
}

// Build the Docker image
async function buildTestImage(dockerTag) {
  console.log('Building the Docker image...');
  try {
    const dockerfilePath = resolve(__dirname, '..', 'test-image.Dockerfile');
    const dockerfileFlag = `-f ${dockerfilePath}`;
    const sudoPrefix = getSudoPrefix();
    // Use the directory containing the Dockerfile as build context (project root)
    const buildContext = resolve(__dirname, '..');
    execSync(
      `${sudoPrefix}docker build ${dockerfileFlag} --platform=linux/amd64 -t ${dockerTag}:latest ${buildContext}`,
      { stdio: 'inherit' }
    );
  } catch (e) {
    throw new Error(`Error building the Docker image: ${e.message}`);
  }
}

// Push the Docker image to docker hub and return the codehash
async function pushTestImage(dockerTag) {
  console.log('Pushing the Docker image...');
  try {
    const sudoPrefix = getSudoPrefix();
    const output = execSync(
      `${sudoPrefix}docker push ${dockerTag}:latest`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );
    const match = output.toString().match(/sha256:[a-f0-9]{64}/gim);
    if (!match || !match[0]) {
      throw new Error('Could not extract codehash from the Docker push output');
    }
    const codehash = match[0].split('sha256:')[1];
    return codehash;
  } catch (e) {
    throw new Error(`Error pushing the Docker image: ${e.message}`);
  }
}

// Update the docker-compose.yaml file with the new image codehash
function updateDockerComposeImage(dockerTag, codehash) {
  console.log('Updating docker-compose.yaml with new image codehash...');
  try {
    const composePath = resolve(__dirname, 'docker-compose.yaml');
    const compose = fs.readFileSync(composePath, 'utf8');
    const doc = parse(compose);

    if (!doc.services || !doc.services['shade-test-image']) {
      throw new Error(`Could not find services.shade-test-image in ${composePath}`);
    }

    // Set image to tag@sha256:codehash
    doc.services['shade-test-image'].image = `${dockerTag}@sha256:${codehash}`;

    const updated = stringify(doc);
    fs.writeFileSync(composePath, updated, 'utf8');
    console.log(`✓ Updated docker-compose.yaml with image ${dockerTag}@sha256:${codehash}`);
  } catch (e) {
    throw new Error(`Error updating docker-compose.yaml: ${e.message}`);
  }
}

// Build, push, and update docker-compose.yaml
async function buildAndPushTestImage() {
  const dockerTag = process.env.DOCKER_TAG || 'pivortex/shade-test-image';
  console.log(`Using Docker tag: ${dockerTag}`);
  
  // Build the image
  await buildTestImage(dockerTag);
  
  // Push the image and get the codehash
  const codehash = await pushTestImage(dockerTag);
  
  // Update docker-compose.yaml
  updateDockerComposeImage(dockerTag, codehash);
  
  return codehash;
}

// Get Phala CLI binary
function getPhalaBin() {
  const cliRoot = resolve(__dirname, '..', 'shade-agent-cli');
  const phalaBin = resolve(cliRoot, 'node_modules', '.bin', 'phala');
  if (fs.existsSync(phalaBin)) {
    return phalaBin;
  }
  throw new Error('Phala CLI not found. Run npm install in shade-agent-cli directory.');
}

// Deploy to Phala
async function deployToPhala() {
  const phalaBin = getPhalaBin();
  const composePath = resolve(__dirname, 'docker-compose.yaml');
  const envFilePath = resolve(__dirname, '.env');

  const result = execSync(
    `${phalaBin} deploy --name ${TEST_APP_NAME} --api-token ${PHALA_API_KEY} --compose ${composePath} --env-file ${envFilePath} --image dstack-0.5.5`,
    { encoding: 'utf-8', stdio: 'pipe' }
  );

  const jsonMatch = result.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Failed to parse Phala deployment response');
  }
  const deployResult = JSON.parse(jsonMatch[0]);
  
  if (!deployResult.success) {
    throw new Error('Phala deployment failed');
  }

  return deployResult.vm_uuid;
}

// Get app URL from Phala (matches CLI implementation)
async function getAppUrl(appId) {
  console.log('Getting the app URL');
  const url = `https://cloud-api.phala.network/api/v1/cvms/${appId}`;
  const maxAttempts = 5;
  const delay = 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'X-API-Key': PHALA_API_KEY } });
      if (!response.ok) {
        if (attempt === maxAttempts) {
          console.log(`HTTP error! status: ${response.status}`);
        }
        continue;
      }
      const data = await response.json();
      if (!data.error) {
        // List all non-empty public URLs
        if (Array.isArray(data.public_urls)) {
          const validUrls = data.public_urls.filter(u => u.app && u.app.trim() !== '');
          if (validUrls.length > 0) {
            // Print URLs and exit immediately
            console.log(`\nYour app is live at:`);
            validUrls.forEach((urlObj, index) => {
              console.log(`  ${index + 1}. ${urlObj.app}${urlObj.instance ? ` (instance: ${urlObj.instance})` : ''}`);
            });
            return validUrls;
          }
        }
      }
    } catch (e) {
      if (attempt === maxAttempts) {
        console.log(`Error fetching CVM network info (attempt ${attempt}): ${e.message}`);
      }
    }
    if (attempt < maxAttempts) {
      await new Promise(res => setTimeout(res, delay));
    }
  }
  console.log(`Failed to get app URL: CVM Network Info did not become ready after ${maxAttempts} attempts.`);
  return null;
}

// Approve measurements
async function approveMeasurements(measurements) {
  console.log('Approving measurements...');
  await account.callFunction({
    contractId: AGENT_CONTRACT_ID,
    methodName: 'approve_measurements',
    args: { measurements },
    gas: tgasToGas(30),
  });
}

// Remove measurements
async function removeMeasurements(measurements) {
  console.log('Removing measurements...');
  await account.callFunction({
    contractId: AGENT_CONTRACT_ID,
    methodName: 'remove_measurements',
    args: { measurements },
    gas: tgasToGas(30),
  });
}

// Approve PPIDs
async function approvePpids(ppids) {
  console.log('Approving PPIDs...');
  await account.callFunction({
    contractId: AGENT_CONTRACT_ID,
    methodName: 'approve_ppids',
    args: { ppids },
    gas: tgasToGas(30),
  });
}

// Remove PPIDs
async function removePpids(ppids) {
  console.log('Removing PPIDs...');
  await account.callFunction({
    contractId: AGENT_CONTRACT_ID,
    methodName: 'remove_ppids',
    args: { ppids },
    gas: tgasToGas(30),
  });
}

// Check if agent is registered
async function isAgentRegistered(agentAccountId) {
  try {
    const result = await provider.callFunction(
      AGENT_CONTRACT_ID,
      'get_agent',
      { account_id: agentAccountId }
    );
    return result !== null && result.account_id !== undefined;
  } catch (e) {
    return false;
  }
}

// Check if app is ready by calling heartbeat endpoint
async function waitForAppReady(baseUrl, maxAttempts = 20, delay = 10000) {
  console.log('Waiting for app to be ready...');
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(baseUrl, {
        method: 'GET',
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.message && data.message.includes('running')) {
          console.log('✓ App is ready');
          return true;
        }
      }
    } catch (e) {
      // Continue retrying
    }
    
    if (attempt < maxAttempts) {
      await new Promise(res => setTimeout(res, delay));
    }
  }
  
  throw new Error(`App did not become ready after ${maxAttempts * delay / 1000} seconds`);
}

// Call test endpoint
async function callTestEndpoint(baseUrl, testName) {
  const url = `${baseUrl}/test/${testName}`;
  console.log(`Calling test endpoint: ${url}`);
  
  const maxAttempts = 5;
  const delay = 2000;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      
      if (response.ok) {
        return await response.json();
      }
      
      if (response.status === 404 && attempt < maxAttempts) {
        // Endpoint not ready yet, retry
        await new Promise(res => setTimeout(res, delay));
        continue;
      }
      
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    } catch (e) {
      if (attempt === maxAttempts) {
        throw e;
      }
      await new Promise(res => setTimeout(res, delay));
    }
  }
}

// Get correct measurements
function getCorrectMeasurements() {
  const composePath = resolve(__dirname, 'docker-compose.yaml');
  return getMeasurements(true, composePath);
}

// Get correct PPIDs
async function getCorrectPpids() {
  return await getPpids(true);
}

// Create wrong measurements (wrong RTMR2)
function getWrongMeasurementsRtmr2() {
  const correct = getCorrectMeasurements();
  return {
    ...correct,
    rtmrs: {
      ...correct.rtmrs,
      rtmr2: '0'.repeat(96), // Wrong RTMR2
    },
  };
}

// Create wrong measurements (wrong key provider)
function getWrongMeasurementsKeyProvider() {
  const correct = getCorrectMeasurements();
  return {
    ...correct,
    key_provider_event_digest: '0'.repeat(96), // Wrong key provider
  };
}

// Create wrong measurements (wrong app compose)
function getWrongMeasurementsAppCompose() {
  const correct = getCorrectMeasurements();
  const composePath = resolve(__dirname, 'docker-compose.yaml');
  
  // Extract allowed envs and remove one
  const allowedEnvs = extractAllowedEnvs(composePath);
  if (allowedEnvs.length === 0) {
    throw new Error('No environment variables found in docker-compose.yaml');
  }
  
  // Remove the first env variable (or last, doesn't matter - just need to change the hash)
  const modifiedEnvs = allowedEnvs.slice(1); // Remove first env
  
  // Calculate hash with modified envs
  const wrongAppComposeHash = calculateAppComposeHash(composePath, modifiedEnvs);
  
  return {
    ...correct,
    app_compose_hash_payload: wrongAppComposeHash, // Wrong app compose (missing one env)
  };
}

// Run a test (assumes appUrl is already available)
async function runTest(appUrl, testName, setupFn, verifyFn) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Running test: ${testName}`);
  console.log('='.repeat(70));
  
  try {
    // Setup
    if (setupFn) {
      await setupFn();
      // Wait a bit for setup to propagate
      await new Promise(res => setTimeout(res, 2000));
    }
    
    // Call test endpoint
    const result = await callTestEndpoint(appUrl, testName);
    
    // Verify
    if (verifyFn) {
      await verifyFn(result);
    }
    
    // Check test result
    if (!result.success) {
      throw new Error(`Test failed: ${result.error || 'Unknown error'}`);
    }
    
    console.log(`✓ Test ${testName} passed`);
    return true;
  } catch (error) {
    console.error(`✗ Test ${testName} failed: ${error.message}`);
    throw error;
  }
}

// Test 1: Can't verify with wrong measurements (RTMR2)
async function test1(appUrl) {
  const wrongMeasurements = getWrongMeasurementsRtmr2();
  const correctPpids = await getCorrectPpids();
  
  await runTest(
    appUrl,
    'wrong-measurements-rtmr2',
    async () => {
      // Approve correct PPID, key provider, app compose, but wrong RTMR2
      await approveMeasurements(wrongMeasurements);
      await approvePpids(correctPpids);
    },
    async (result) => {
      // Check that agent is not registered
      const registered = await isAgentRegistered(result.agentAccountId);
      if (registered) {
        throw new Error('Agent should not be registered');
      }
      
      // Verify registrationError matches WrongHash format with rtmr2
      const registrationError = result.registrationError || '';
      if (!registrationError.match(/wrong rtmr2_(report_data|tcb_info) hash \(found .+ expected .+\)/i)) {
        throw new Error(`Expected WrongHash error with rtmr2, got: ${registrationError}`);
      }
      
      // Verify callError contains "Agent not registered"
      const callError = result.callError || '';
      if (!callError.includes('Agent not registered')) {
        throw new Error(`Expected callError to contain 'Agent not registered', got: ${callError}`);
      }
      
      // Remove wrong measurements
      await removeMeasurements(wrongMeasurements);
    }
  );
}

// Test 2: Can't verify with wrong key provider
async function test2(appUrl) {
  const wrongMeasurements = getWrongMeasurementsKeyProvider();
  const correctPpids = await getCorrectPpids();
  
  await runTest(
    appUrl,
    'wrong-key-provider',
    async () => {
      await approveMeasurements(wrongMeasurements);
      await approvePpids(correctPpids);
    },
    async (result) => {
      const registered = await isAgentRegistered(result.agentAccountId);
      if (registered) {
        throw new Error('Agent should not be registered');
      }
      
      // Verify registrationError matches WrongHash format with key_provider
      const registrationError = result.registrationError || '';
      if (!registrationError.match(/wrong key_provider hash \(found .+ expected .+\)/i)) {
        throw new Error(`Expected WrongHash error with key_provider, got: ${registrationError}`);
      }
      
      // Verify callError contains "Agent not registered"
      const callError = result.callError || '';
      if (!callError.includes('Agent not registered')) {
        throw new Error(`Expected callError to contain 'Agent not registered', got: ${callError}`);
      }
      
      await removeMeasurements(wrongMeasurements);
    }
  );
}

// Test 3: Can't verify with wrong app compose
async function test3(appUrl) {
  const wrongMeasurements = getWrongMeasurementsAppCompose();
  const correctPpids = await getCorrectPpids();
  
  await runTest(
    appUrl,
    'wrong-app-compose',
    async () => {
      await approveMeasurements(wrongMeasurements);
      await approvePpids(correctPpids);
    },
    async (result) => {
      const registered = await isAgentRegistered(result.agentAccountId);
      if (registered) {
        throw new Error('Agent should not be registered');
      }
      
      // Verify registrationError matches WrongHash format with app_compose_hash
      const registrationError = result.registrationError || '';
      if (!registrationError.match(/wrong app_compose_hash hash \(found .+ expected .+\)/i)) {
        throw new Error(`Expected WrongHash error with app_compose_hash, got: ${registrationError}`);
      }
      
      // Verify callError contains "Agent not registered"
      const callError = result.callError || '';
      if (!callError.includes('Agent not registered')) {
        throw new Error(`Expected callError to contain 'Agent not registered', got: ${callError}`);
      }
      
      await removeMeasurements(wrongMeasurements);
    }
  );
}

// Test 4: Can't verify with wrong PPID
async function test4(appUrl) {
  const correctMeasurements = getCorrectMeasurements();
  const wrongPpid = ['00000000000000000000000000000000']; // Wrong PPID
  
  await runTest(
    appUrl,
    'wrong-ppid',
    async () => {
      await approveMeasurements(correctMeasurements);
      await approvePpids(wrongPpid);
    },
    async (result) => {
      const registered = await isAgentRegistered(result.agentAccountId);
      if (registered) {
        throw new Error('Agent should not be registered');
      }
      
      // Verify registrationError contains PPID not in allowed list custom error
      const registrationError = result.registrationError || '';
      if (!registrationError.toLowerCase().includes('ppid') || !registrationError.toLowerCase().includes('not in the allowed ppids list')) {
        throw new Error(`Expected error about PPID not in allowed list, got: ${registrationError}`);
      }
      
      // Verify callError contains "Agent not registered"
      const callError = result.callError || '';
      if (!callError.includes('Agent not registered')) {
        throw new Error(`Expected callError to contain 'Agent not registered', got: ${callError}`);
      }
    }
  );
}

// Test 5: Can't submit attestation from different account ID
async function test5(appUrl) {
  const correctMeasurements = getCorrectMeasurements();
  const correctPpids = await getCorrectPpids();
  
  await runTest(
    appUrl,
    'different-account-id',
    async () => {
      await approveMeasurements(correctMeasurements);
      await approvePpids(correctPpids);
    },
    async (result) => {
      // Check that the agent is registered
      const registered = await isAgentRegistered(result.agentAccountId);
      if (!registered) {
        throw new Error('Agent should be registered');
      }
      // Check that no other agent is registered
      const agents = await provider.callFunction(
        AGENT_CONTRACT_ID,
        'get_agents',
        {}
      );
      if (agents.length !== 1) {
        throw new Error(`Expected 1 registered agent, found ${agents.length}`);
      }
      
      // Verify registrationError matches WrongHash format with report_data
      const registrationError = result.registrationError || '';
      if (!registrationError.match(/wrong report_data hash \(found .+ expected .+\)/i)) {
        throw new Error(`Expected WrongHash error with report_data, got: ${registrationError}`);
      }
      
      // Verify callError contains "Agent not registered"
      const callError = result.callError || '';
      if (!callError.includes('Agent not registered')) {
        throw new Error(`Expected callError to contain 'Agent not registered', got: ${callError}`);
      }
    }
  );
}

// Test 6: Can't do stuff if measurements are removed
async function test6(appUrl) {
  const correctMeasurements = getCorrectMeasurements();
  const correctPpids = await getCorrectPpids();
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Running test: measurements-removed`);
  console.log('='.repeat(70));
  
  // First approve measurements and PPIDs (if not already approved)
  await approveMeasurements(correctMeasurements);
  await approvePpids(correctPpids);
  
  // Wait for agent to register (if not already registered)
  console.log('Waiting for agent to register...');
  await new Promise(res => setTimeout(res, 10000));
  
  // Now remove measurements
  await removeMeasurements(correctMeasurements);
  
  // Wait a bit for the removal to propagate
  await new Promise(res => setTimeout(res, 2000));
  
  // Call test endpoint
  const result = await callTestEndpoint(appUrl, 'measurements-removed');
  
  if (!result.success) {
    throw new Error(`Test failed: ${result.error || 'Unknown error'}`);
  }
  
  // Verify error contains "Agent not registered with approved measurements"
  const errorMsg = result.callError || '';
  if (!errorMsg.includes('Agent not registered with approved measurements')) {
    throw new Error(`Expected error 'Agent not registered with approved measurements', got: ${errorMsg}`);
  }
  
  console.log(`✓ Test measurements-removed passed`);
}

// Test 7: Can't do stuff if PPID is removed
async function test7(appUrl) {
  const correctMeasurements = getCorrectMeasurements();
  const correctPpids = await getCorrectPpids();
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Running test: ppid-removed`);
  console.log('='.repeat(70));
  
  // First approve measurements and PPIDs (if not already approved)
  await approveMeasurements(correctMeasurements);
  await approvePpids(correctPpids);
  
  // Wait for agent to register (if not already registered)
  console.log('Waiting for agent to register...');
  await new Promise(res => setTimeout(res, 10000));
  
  // Now remove PPID
  await removePpids(correctPpids);
  
  // Wait a bit for the removal to propagate
  await new Promise(res => setTimeout(res, 2000));
  
  // Call test endpoint
  const result = await callTestEndpoint(appUrl, 'ppid-removed');
  
  if (!result.success) {
    throw new Error(`Test failed: ${result.error || 'Unknown error'}`);
  }
  
  // Verify error contains "Agent not registered with approved PPID"
  const errorMsg = result.callError || '';
  if (!errorMsg.includes('Agent not registered with approved PPID')) {
    throw new Error(`Expected error 'Agent not registered with approved PPID', got: ${errorMsg}`);
  }
  
  console.log(`✓ Test ppid-removed passed`);
}

// Main execution
async function main() {
  console.log('\n' + '='.repeat(70));
  console.log('Starting Integration Tests');
  console.log('='.repeat(70));
  
  // Update .env file with generated contract ID
  updateEnvFile();
  
  // Deploy contract to testnet (skip if SKIP_CONTRACT_DEPLOYMENT is true)
  if (!SKIP_CONTRACT_DEPLOYMENT) {
    console.log('\nDeploying contract to testnet...');
    await createContractAccount();
    await deployContract();
    await initializeContract();
    console.log('✓ Contract deployment complete\n');
  } else {
    console.log('\n⚠ Skipping contract deployment (SKIP_CONTRACT_DEPLOYMENT=true)\n');
  }
  
  // Build, push, and update docker-compose.yaml with the test image
  console.log('\nBuilding and pushing test image...');
  await buildAndPushTestImage();
  console.log('✓ Test image built and pushed\n');
  
  // Deploy to Phala once
  console.log('Deploying test image to Phala...');
  const appId = await deployToPhala();
  const appUrls = await getAppUrl(appId);
  if (!appUrls || appUrls.length === 0) {
    throw new Error('Failed to get app URL from Phala');
  }
  const appUrl = appUrls[0].app;
  console.log(`✓ App deployed at: ${appUrl}`);
  
  // Wait for the app to be ready using heartbeat
  await waitForAppReady(appUrl);
  
  const tests = [
    { name: 'Test 1: Wrong measurements (RTMR2)', fn: test1 },
    { name: 'Test 2: Wrong key provider', fn: test2 },
    { name: 'Test 3: Wrong app compose', fn: test3 },
    { name: 'Test 4: Wrong PPID', fn: test4 },
    { name: 'Test 5: Different account ID', fn: test5 },
    { name: 'Test 6: Measurements removed', fn: test6 },
    { name: 'Test 7: PPID removed', fn: test7 },
  ];
  
  const failedTests = [];
  
  for (const test of tests) {
    try {
      await test.fn(appUrl);
    } catch (error) {
      console.error(`\n✗ ${test.name} FAILED: ${error.message}`);
      failedTests.push(test.name);
      // Continue with next test
    }
  }
  
  console.log(`\n${'='.repeat(70)}`);
  console.log('Test Summary');
  console.log('='.repeat(70));
  console.log(`Total tests: ${tests.length}`);
  console.log(`Passed: ${tests.length - failedTests.length}`);
  console.log(`Failed: ${failedTests.length}`);
  
  if (failedTests.length > 0) {
    console.log('\nFailed tests:');
    failedTests.forEach(name => console.log(`  - ${name}`));
    process.exit(1);
  }
  
  console.log('\n✓ All tests passed!');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
