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
import { Account, KeyPairSigner } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { getMeasurements, calculateAppComposeHash, extractAllowedEnvs } from '../shade-agent-cli/src/utils/measurements.js';
import { getPpids } from '../shade-agent-cli/src/utils/ppids.js';
import { tgasToGas } from '../shade-agent-cli/src/utils/near.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
const TESTNET_ACCOUNT_ID = process.env.TESTNET_ACCOUNT_ID;
const TESTNET_PRIVATE_KEY = process.env.TESTNET_PRIVATE_KEY;
const AGENT_CONTRACT_ID = process.env.AGENT_CONTRACT_ID;
const PHALA_API_KEY = process.env.PHALA_API_KEY;

if (!TESTNET_ACCOUNT_ID || !TESTNET_PRIVATE_KEY || !AGENT_CONTRACT_ID || !PHALA_API_KEY) {
  console.error('Missing required environment variables:');
  console.error('  TESTNET_ACCOUNT_ID');
  console.error('  TESTNET_PRIVATE_KEY');
  console.error('  AGENT_CONTRACT_ID');
  console.error('  PHALA_API_KEY');
  process.exit(1);
}

const TEST_APP_NAME = 'shade-integration-tests';

// Initialize NEAR account
const provider = new Provider({
  type: 'JsonRpcProvider',
  args: {
    url: 'https://rpc.testnet.near.org',
  },
});

const keyPair = KeyPair.fromString(TESTNET_PRIVATE_KEY);
const signer = KeyPairSigner.fromKeyPair(keyPair);
const account = new Account(TESTNET_ACCOUNT_ID, provider, signer);

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
  console.log('Deploying test image to Phala...');
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

// Get app URL from Phala
async function getAppUrl(appId) {
  console.log('Waiting for app URL...');
  const url = `https://cloud-api.phala.network/api/v1/cvms/${appId}`;
  const maxAttempts = 10;
  const delay = 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'X-API-Key': PHALA_API_KEY },
      });
      
      if (response.ok) {
        const data = await response.json();
        if (!data.error && Array.isArray(data.public_urls)) {
          const validUrls = data.public_urls.filter(u => u.app && u.app.trim() !== '');
          if (validUrls.length > 0) {
            return validUrls[0].app;
          }
        }
      }
    } catch (e) {
      // Continue retrying
    }
    
    if (attempt < maxAttempts) {
      await new Promise(res => setTimeout(res, delay));
    }
  }
  
  throw new Error('Failed to get app URL');
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
  
  console.log(`✓ Test ppid-removed passed`);
}

// Main execution
async function main() {
  console.log('\n' + '='.repeat(70));
  console.log('Starting Integration Tests');
  console.log('='.repeat(70));
  
  // Deploy to Phala once
  console.log('\nDeploying test image to Phala...');
  const appId = await deployToPhala();
  const appUrl = await getAppUrl(appId);
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
