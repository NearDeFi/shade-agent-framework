#!/usr/bin/env node

/**
 * Test script that runs outside the TEE
 * Orchestrates tests by:
 * 1. Setting up contract (approving/removing measurements and PPIDs)
 * 2. Deploying to Phala
 * 3. Calling test endpoints
 * 4. Verifying results
 */

import { execSync } from "child_process";
import { fileURLToPath } from "url";
import path, { dirname, resolve } from "path";
import fs from "fs";
import dotenv from "dotenv";
import { parse, stringify } from "yaml";
import { platform } from "os";
import { Account } from "@near-js/accounts";
import { KeyPairSigner } from "@near-js/signers";
import { JsonRpcProvider } from "@near-js/providers";
import { NEAR } from "@near-js/tokens";
import {
  getMeasurements,
  calculateAppComposeHash,
  extractAllowedEnvs,
} from "../shade-agent-cli/src/utils/measurements.js";
import { getPpids } from "../shade-agent-cli/src/utils/ppids.js";
import { tgasToGas } from "../shade-agent-cli/src/utils/near.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from .env file
const envPath = resolve(__dirname, ".env");
dotenv.config({ path: envPath });

// Load environment variables
const TESTNET_ACCOUNT_ID = process.env.TESTNET_ACCOUNT_ID;
const TESTNET_PRIVATE_KEY = process.env.TESTNET_PRIVATE_KEY;
const PHALA_API_KEY = process.env.PHALA_API_KEY;

if (!TESTNET_ACCOUNT_ID || !TESTNET_PRIVATE_KEY || !PHALA_API_KEY) {
  console.error("Missing required environment variables:");
  console.error("  TESTNET_ACCOUNT_ID");
  console.error("  TESTNET_PRIVATE_KEY");
  console.error("  PHALA_API_KEY");
  process.exit(1);
}

// Generate contract ID as subaccount of TESTNET_ACCOUNT_ID
const AGENT_CONTRACT_ID = `shade-test-contract.${TESTNET_ACCOUNT_ID}`;
const TEST_APP_NAME = "shade-integration-tests";

// Toggle to skip redeploying account, contract, and initialization (useful for reusing existing deployment)
const SKIP_CONTRACT_DEPLOYMENT = true;

// Toggle to skip Phala deployment - ON if TEST_APP_URL is specified, OFF if empty
// const TEST_APP_URL = "https://45034fea45a406a829feea099c77bbe6cf26faed-3000.dstack-pha-prod7.phala.network";
const SKIP_PHALA_DEPLOYMENT = false;

// Write AGENT_CONTRACT_ID to .env file for docker-compose
function updateEnvFile() {
  const envPath = resolve(__dirname, ".env");
  let envContent = "";

  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, "utf8");
  }

  // Update or add AGENT_CONTRACT_ID
  const lines = envContent.split("\n");
  let found = false;
  const updatedLines = lines.map((line) => {
    if (line.startsWith("AGENT_CONTRACT_ID=")) {
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
  const finalLines = updatedLines.map((line) => {
    if (line.startsWith("SPONSOR_ACCOUNT_ID=")) {
      sponsorAccountFound = true;
      return `SPONSOR_ACCOUNT_ID=${TESTNET_ACCOUNT_ID}`;
    }
    if (line.startsWith("SPONSOR_PRIVATE_KEY=")) {
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

  fs.writeFileSync(envPath, finalLines.join("\n") + "\n");
  console.log(
    `✓ Updated .env file with AGENT_CONTRACT_ID=${AGENT_CONTRACT_ID}`,
  );
}

// Initialize NEAR account
const provider = new JsonRpcProvider(
  {
    url: "https://test.rpc.fastnear.com",
  },
  {
    retries: 3,
    backoff: 2,
    wait: 1000,
  },
);

const signer = KeyPairSigner.fromSecretKey(TESTNET_PRIVATE_KEY);
const account = new Account(TESTNET_ACCOUNT_ID, provider, signer);
const contractAccount = new Account(AGENT_CONTRACT_ID, provider, signer);

// Sleep helper
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Create contract account (as subaccount of TESTNET_ACCOUNT_ID)
async function createContractAccount() {
  console.log("Creating contract account...");
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
    if (e.type !== "AccountDoesNotExist") {
      throw new Error(`Error checking contract account: ${e.message}`);
    }
  }

  const totalBalance = masterBalanceDecimal + contractBalanceDecimal;

  if (totalBalance < requiredBalance) {
    throw new Error(
      `Insufficient balance. Master account has ${totalBalance} NEAR but needs ${requiredBalance} NEAR ` +
        `(${fundingAmount} NEAR for contract + 0.1 NEAR for fees)`,
    );
  }

  // Delete the contract account if it exists
  if (contractAccountExists) {
    console.log("Contract account already exists, deleting it...");
    try {
      await contractAccount.deleteAccount(TESTNET_ACCOUNT_ID);
      await sleep(2000);
    } catch (deleteError) {
      if (deleteError.type === "AccessKeyDoesNotExist") {
        throw new Error(
          "Cannot delete contract account - access key mismatch. " +
            "The contract account was created with a different master account.",
        );
      }
      throw new Error(
        `Failed to delete existing contract account: ${deleteError.message}`,
      );
    }
  } else {
    console.log("Contract account does not exist, creating it");
  }

  // Create the contract account
  try {
    const publicKey = await account.getSigner().getPublicKey();
    const result = await account.createAccount(
      AGENT_CONTRACT_ID,
      publicKey,
      NEAR.toUnits(fundingAmount),
    );

    await sleep(2000);
    console.log(`✓ Contract account created: ${AGENT_CONTRACT_ID}`);
  } catch (e) {
    throw new Error(`Failed to create contract account: ${e.message}`);
  }
}

// Deploy contract WASM
async function deployContract() {
  console.log("Deploying contract WASM...");
  const wasmPath = resolve(
    __dirname,
    "..",
    "shade-contract-template",
    "target",
    "near",
    "shade_contract_template.wasm",
  );

  if (!fs.existsSync(wasmPath)) {
    throw new Error(
      `WASM file not found at ${wasmPath}. Please build the contract first.`,
    );
  }

  try {
    const wasmBytes = fs.readFileSync(wasmPath);
    await contractAccount.deployContract(new Uint8Array(wasmBytes));
    await sleep(2000);
    console.log("✓ Contract deployed");
  } catch (e) {
    throw new Error(`Failed to deploy contract: ${e.message}`);
  }
}

// Initialize contract
async function initializeContract() {
  console.log("Initializing contract...");

  const initArgs = {
    requires_tee: true,
    attestation_expiration_time_ms: "100000", // 100 seconds in milliseconds (as U64 string)
    owner_id: TESTNET_ACCOUNT_ID,
    mpc_contract_id: "v1.signer-prod.testnet", // testnet MPC contract
  };

  try {
    await contractAccount.callFunction({
      contractId: AGENT_CONTRACT_ID,
      methodName: "new",
      args: initArgs,
      gas: tgasToGas(30),
    });
    await sleep(2000);
    console.log("✓ Contract initialized");
  } catch (e) {
    throw new Error(`Failed to initialize contract: ${e.message}`);
  }
}

// Get sudo prefix for Docker commands based on OS
function getSudoPrefix() {
  const platformName = platform();
  return platformName === "linux" ? "sudo " : "";
}

// Build the Docker image
async function buildTestImage(dockerTag) {
  console.log("Building the Docker image...");
  try {
    const dockerfilePath = resolve(__dirname, "..", "test-image.Dockerfile");
    const dockerfileFlag = `-f ${dockerfilePath}`;
    const sudoPrefix = getSudoPrefix();
    // Use the directory containing the Dockerfile as build context (project root)
    const buildContext = resolve(__dirname, "..");
    execSync(
      `${sudoPrefix}docker build ${dockerfileFlag} --platform=linux/amd64 -t ${dockerTag}:latest ${buildContext}`,
      { stdio: "inherit" },
    );
  } catch (e) {
    throw new Error(`Error building the Docker image: ${e.message}`);
  }
}

// Push the Docker image to docker hub and return the codehash
async function pushTestImage(dockerTag) {
  console.log("Pushing the Docker image...");
  try {
    const sudoPrefix = getSudoPrefix();
    const output = execSync(`${sudoPrefix}docker push ${dockerTag}:latest`, {
      encoding: "utf-8",
      stdio: "pipe",
    });
    const match = output.toString().match(/sha256:[a-f0-9]{64}/gim);
    if (!match || !match[0]) {
      throw new Error("Could not extract codehash from the Docker push output");
    }
    const codehash = match[0].split("sha256:")[1];
    return codehash;
  } catch (e) {
    throw new Error(`Error pushing the Docker image: ${e.message}`);
  }
}

// Update the docker-compose.yaml file with the new image codehash
function updateDockerComposeImage(dockerTag, codehash) {
  console.log("Updating docker-compose.yaml with new image codehash...");
  try {
    const composePath = resolve(__dirname, "docker-compose.yaml");
    const compose = fs.readFileSync(composePath, "utf8");
    const doc = parse(compose);

    if (!doc.services || !doc.services["shade-test-image"]) {
      throw new Error(
        `Could not find services.shade-test-image in ${composePath}`,
      );
    }

    // Set image to tag@sha256:codehash
    doc.services["shade-test-image"].image = `${dockerTag}@sha256:${codehash}`;

    const updated = stringify(doc);
    fs.writeFileSync(composePath, updated, "utf8");
    console.log(
      `✓ Updated docker-compose.yaml with image ${dockerTag}@sha256:${codehash}`,
    );
  } catch (e) {
    throw new Error(`Error updating docker-compose.yaml: ${e.message}`);
  }
}

// Build, push, and update docker-compose.yaml
async function buildAndPushTestImage() {
  const dockerTag = process.env.DOCKER_TAG || "pivortex/shade-test-image";
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
  const phalaBin = resolve(__dirname, "node_modules", ".bin", "phala");
  if (fs.existsSync(phalaBin)) {
    return phalaBin;
  }
  throw new Error(
    "Phala CLI not found. Run npm install in shade-agent-cli directory.",
  );
}

// Deploy to Phala
async function deployToPhala() {
  const phalaBin = getPhalaBin();
  const composePath = resolve(__dirname, "docker-compose.yaml");
  const envFilePath = resolve(__dirname, ".env");

  // Extract allowed environment variables from docker-compose.yaml
  const allowedEnvs = extractAllowedEnvs(composePath);

  // Build environment variable flags for Phala CLI
  // Only include env vars that are allowed in docker-compose.yaml
  let envFlags = "";
  if (envFilePath && allowedEnvs.length > 0) {
    // Resolve env file path relative to current working directory
    const resolvedEnvFilePath = path.isAbsolute(envFilePath)
      ? envFilePath
      : path.resolve(process.cwd(), envFilePath);

    // Read the env file and extract values for allowed env vars
    if (!fs.existsSync(resolvedEnvFilePath)) {
      console.log(
        `Warning: Env file not found at ${resolvedEnvFilePath}, skipping environment variables`,
      );
    } else {
      const envFileContent = fs.readFileSync(resolvedEnvFilePath, "utf8");
      const envVars = {};

      // Parse .env file (simple key=value format)
      envFileContent.split("\n").forEach((line) => {
        line = line.trim();
        // Skip comments and empty lines
        if (line && !line.startsWith("#")) {
          const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
          if (match) {
            const [, key, value] = match;
            // Remove quotes if present (handles both single and double quotes)
            const cleanValue = value.replace(/^["']|["']$/g, "");
            envVars[key] = cleanValue;
          }
        }
      });

      // Build -e KEY=VALUE flags for allowed env vars only
      // Escape values that contain spaces or special characters
      const envFlagArray = allowedEnvs
        .filter((key) => envVars.hasOwnProperty(key))
        .map((key) => {
          const value = envVars[key];
          // Quote value if it contains spaces or special characters
          const escapedValue =
            value.includes(" ") || value.includes("$") || value.includes("`")
              ? `"${value.replace(/"/g, '\\"')}"`
              : value;
          return `-e ${key}=${escapedValue}`;
        });

      if (envFlagArray.length > 0) {
        envFlags = envFlagArray.join(" ");
      }
    }
  }

  const result = execSync(
    `${phalaBin} deploy --name ${TEST_APP_NAME} --api-token ${PHALA_API_KEY} --compose ${composePath} ${envFlags} --image dstack-0.5.5`,
    {
      encoding: "utf-8",
      stdio: "pipe",
      env: { ...process.env, PHALA_CLOUD_API_KEY: PHALA_API_KEY },
    },
  );

  const jsonMatch = result.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Failed to parse Phala deployment response");
  }
  const deployResult = JSON.parse(jsonMatch[0]);

  if (!deployResult.success) {
    throw new Error("Phala deployment failed");
  }

  return deployResult.vm_uuid;
}

// Get app URL from Phala (matches CLI implementation)
async function getAppUrl(appId) {
  console.log("Getting the app URL");
  const url = `https://cloud-api.phala.network/api/v1/cvms/${appId}`;
  const maxAttempts = 5;
  const delay = 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "X-API-Key": PHALA_API_KEY },
      });
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
          const validUrls = data.public_urls.filter(
            (u) => u.app && u.app.trim() !== "",
          );
          if (validUrls.length > 0) {
            // Print URLs and exit immediately
            console.log(`\nYour app is live at:`);
            validUrls.forEach((urlObj, index) => {
              console.log(
                `  ${index + 1}. ${urlObj.app}${urlObj.instance ? ` (instance: ${urlObj.instance})` : ""}`,
              );
            });
            return validUrls;
          }
        }
      }
    } catch (e) {
      if (attempt === maxAttempts) {
        console.log(
          `Error fetching CVM network info (attempt ${attempt}): ${e.message}`,
        );
      }
    }
    if (attempt < maxAttempts) {
      await new Promise((res) => setTimeout(res, delay));
    }
  }
  console.log(
    `Failed to get app URL: CVM Network Info did not become ready after ${maxAttempts} attempts.`,
  );
  return null;
}

// Approve measurements
async function approveMeasurements(measurements) {
  console.log("Approving measurements...");
  await account.callFunction({
    contractId: AGENT_CONTRACT_ID,
    methodName: "approve_measurements",
    args: { measurements },
    gas: tgasToGas(30),
  });
}

// Remove measurements
async function removeMeasurements(measurements) {
  console.log("Removing measurements...");
  await account.callFunction({
    contractId: AGENT_CONTRACT_ID,
    methodName: "remove_measurements",
    args: { measurements },
    gas: tgasToGas(30),
  });
}

// Approve PPIDs
async function approvePpids(ppids) {
  console.log("Approving PPIDs...");
  await account.callFunction({
    contractId: AGENT_CONTRACT_ID,
    methodName: "approve_ppids",
    args: { ppids },
    gas: tgasToGas(30),
  });
}

// Remove PPIDs
async function removePpids(ppids) {
  console.log("Removing PPIDs...");
  await account.callFunction({
    contractId: AGENT_CONTRACT_ID,
    methodName: "remove_ppids",
    args: { ppids },
    gas: tgasToGas(30),
  });
}

// Update attestation expiration time (owner only). Pass ms as number or string.
async function updateAttestationExpirationTime(ms) {
  const msStr = String(ms);
  console.log(`Updating attestation expiration to ${msStr} ms...`);
  await account.callFunction({
    contractId: AGENT_CONTRACT_ID,
    methodName: "update_attestation_expiration_time",
    args: { attestation_expiration_time_ms: msStr },
    gas: tgasToGas(30),
  });
}

// Check if agent is registered
async function isAgentRegistered(agentAccountId) {
  try {
    const result = await provider.callFunction(AGENT_CONTRACT_ID, "get_agent", {
      account_id: agentAccountId,
    });
    return result !== null && result.account_id !== undefined;
  } catch (e) {
    return false;
  }
}

// Check if app is ready by calling heartbeat endpoint
async function waitForAppReady(baseUrl, maxAttempts = 20, delay = 10000) {
  console.log("Waiting for app to be ready...");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(baseUrl, {
        method: "GET",
      });

      if (response.ok) {
        const data = await response.json();
        if (data.message && data.message.includes("running")) {
          console.log("✓ App is ready");
          return true;
        }
      }
    } catch (e) {
      // Continue retrying
    }

    if (attempt < maxAttempts) {
      await new Promise((res) => setTimeout(res, delay));
    }
  }

  throw new Error(
    `App did not become ready after ${(maxAttempts * delay) / 1000} seconds`,
  );
}

// Patterns that indicate a private key leak (NEAR ed25519/secp256k1 format)
const PRIVATE_KEY_PATTERNS = [
  /ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/,
  /secp256k1:[1-9A-HJ-NP-Za-km-z]{40,}/,
];

function containsPrivateKey(text) {
  if (!text || typeof text !== "string") return false;
  return PRIVATE_KEY_PATTERNS.some((re) => re.test(text));
}

// Call test endpoint
// Options: { checkForPrivateKeyLeak: boolean } - when true, fails if response contains private key patterns
async function callTestEndpoint(baseUrl, testName, options = {}) {
  const { checkForPrivateKeyLeak = false } = options;
  const url = `${baseUrl}/test/${testName}`;
  console.log(`Calling test endpoint: ${url}`);

  const maxAttempts = 5;
  const delay = 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const responseText = await response.text();

      if (checkForPrivateKeyLeak && containsPrivateKey(responseText)) {
        throw new Error(
          `PRIVATE KEY LEAK DETECTED: Response from ${testName} contains private key patterns`,
        );
      }

      if (response.ok) {
        return JSON.parse(responseText);
      }

      if (response.status === 404 && attempt < maxAttempts) {
        // Endpoint not ready yet, retry
        await new Promise((res) => setTimeout(res, delay));
        continue;
      }

      throw new Error(`HTTP ${response.status}: ${responseText}`);
    } catch (e) {
      if (attempt === maxAttempts) {
        throw e;
      }
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

// Get correct measurements
function getCorrectMeasurements() {
  const composePath = resolve(__dirname, "docker-compose.yaml");
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
      rtmr2: "0".repeat(96), // Wrong RTMR2
    },
  };
}

// Create wrong measurements (wrong key provider)
function getWrongMeasurementsKeyProvider() {
  const correct = getCorrectMeasurements();
  return {
    ...correct,
    key_provider_event_digest: "0".repeat(96), // Wrong key provider
  };
}

// Create wrong measurements (wrong app compose)
function getWrongMeasurementsAppCompose() {
  const correct = getCorrectMeasurements();
  const composePath = resolve(__dirname, "docker-compose.yaml");

  // Extract allowed envs and remove one
  const allowedEnvs = extractAllowedEnvs(composePath);
  if (allowedEnvs.length === 0) {
    throw new Error("No environment variables found in docker-compose.yaml");
  }

  // Remove the first env variable (or last, doesn't matter - just need to change the hash)
  const modifiedEnvs = allowedEnvs.slice(1); // Remove first env

  // Calculate hash with modified envs
  const wrongAppComposeHash = calculateAppComposeHash(
    composePath,
    modifiedEnvs,
  );

  return {
    ...correct,
    app_compose_hash_payload: wrongAppComposeHash, // Wrong app compose (missing one env)
  };
}

// Run a test (assumes appUrl is already available)
async function runTest(appUrl, testName, setupFn, verifyFn, options = {}) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`Running test: ${testName}`);
  console.log("=".repeat(70));

  try {
    // Setup
    if (setupFn) {
      await setupFn();
      // Wait a bit for setup to propagate
      await new Promise((res) => setTimeout(res, 2000));
    }

    // Call test endpoint
    const result = await callTestEndpoint(appUrl, testName, options);

    // Verify (script does all error checking)
    if (verifyFn) {
      await verifyFn(result);
    }

    console.log(`✓ Test ${testName} passed`);
    return true;
  } catch (error) {
    console.error(`✗ Test ${testName} failed: ${error.message}`);
    throw error;
  }
}

// Test 1: Successful registration and signature request
async function test1(appUrl) {
  const correctMeasurements = getCorrectMeasurements();
  const correctPpids = await getCorrectPpids();

  await runTest(
    appUrl,
    "successful-registration",
    async () => {
      // Approve measurements and PPIDs
      await approveMeasurements(correctMeasurements);
      await approvePpids(correctPpids);
    },
    async (result) => {
      // Check that no errors occurred
      if (result.registrationError) {
        throw new Error(
          `Registration should have succeeded, got error: ${result.registrationError}`,
        );
      }
      if (result.callError) {
        throw new Error(
          `Call should have succeeded, got error: ${result.callError}`,
        );
      }

      // Verify agent is registered externally
      const registered = await isAgentRegistered(result.agentAccountId);
      if (!registered) {
        throw new Error("Agent should be registered but is not");
      }

      // Cleanup: Remove measurements and PPIDs
      await removeMeasurements(correctMeasurements);
      await removePpids(correctPpids);
    },
  );
}

// Test 2: Can't verify with wrong measurements (RTMR2)
async function test2(appUrl) {
  const wrongMeasurements = getWrongMeasurementsRtmr2();
  const correctPpids = await getCorrectPpids();

  await runTest(
    appUrl,
    "wrong-measurements-rtmr2",
    async () => {
      // Approve correct PPID, key provider, app compose, but wrong RTMR2
      await approveMeasurements(wrongMeasurements);
      await approvePpids(correctPpids);
    },
    async (result) => {
      // Check that agent is not registered
      const registered = await isAgentRegistered(result.agentAccountId);
      if (registered) {
        throw new Error("Agent should not be registered");
      }

      // Verify registrationError matches generic expected_measurements error
      const registrationError = result.registrationError || "";
      if (
        !registrationError.includes("wrong expected_measurements hash") ||
        !registrationError.includes(
          "found none matched expected one of the embedded TCB info sets",
        )
      ) {
        throw new Error(
          `Expected wrong expected_measurements hash error, got: ${registrationError}`,
        );
      }

      // Verify callError contains "Agent not registered"
      const callError = result.callError || "";
      if (!callError.includes("Agent not registered")) {
        throw new Error(
          `Expected callError to contain 'Agent not registered', got: ${callError}`,
        );
      }

      await removeMeasurements(wrongMeasurements);
      await removePpids(correctPpids);
    },
  );
}

// Test 3: Can't verify with wrong key provider
async function test3(appUrl) {
  const wrongMeasurements = getWrongMeasurementsKeyProvider();
  const correctPpids = await getCorrectPpids();

  await runTest(
    appUrl,
    "wrong-key-provider",
    async () => {
      await approveMeasurements(wrongMeasurements);
      await approvePpids(correctPpids);
    },
    async (result) => {
      const registered = await isAgentRegistered(result.agentAccountId);
      if (registered) {
        throw new Error("Agent should not be registered");
      }

      // Verify registrationError matches generic expected_measurements error
      const registrationError = result.registrationError || "";
      if (
        !registrationError.includes("wrong expected_measurements hash") ||
        !registrationError.includes(
          "found none matched expected one of the embedded TCB info sets",
        )
      ) {
        throw new Error(
          `Expected wrong expected_measurements hash error, got: ${registrationError}`,
        );
      }

      // Verify callError contains "Agent not registered"
      const callError = result.callError || "";
      if (!callError.includes("Agent not registered")) {
        throw new Error(
          `Expected callError to contain 'Agent not registered', got: ${callError}`,
        );
      }

      await removeMeasurements(wrongMeasurements);
      await removePpids(correctPpids);
    },
  );
}

// Test 4: Can't verify with wrong app compose
async function test4(appUrl) {
  const wrongMeasurements = getWrongMeasurementsAppCompose();
  const correctPpids = await getCorrectPpids();

  await runTest(
    appUrl,
    "wrong-app-compose",
    async () => {
      await approveMeasurements(wrongMeasurements);
      await approvePpids(correctPpids);
    },
    async (result) => {
      const registered = await isAgentRegistered(result.agentAccountId);
      if (registered) {
        throw new Error("Agent should not be registered");
      }

      // Verify registrationError matches generic expected_measurements error
      const registrationError = result.registrationError || "";
      if (
        !registrationError.includes("wrong expected_measurements hash") ||
        !registrationError.includes(
          "found none matched expected one of the embedded TCB info sets",
        )
      ) {
        throw new Error(
          `Expected wrong expected_measurements hash error, got: ${registrationError}`,
        );
      }

      // Verify callError contains "Agent not registered"
      const callError = result.callError || "";
      if (!callError.includes("Agent not registered")) {
        throw new Error(
          `Expected callError to contain 'Agent not registered', got: ${callError}`,
        );
      }

      await removeMeasurements(wrongMeasurements);
      await removePpids(correctPpids);
    },
  );
}

// Test 5: Can't verify with wrong PPID
async function test5(appUrl) {
  const correctMeasurements = getCorrectMeasurements();
  const wrongPpid = ["00000000000000000000000000000000"]; // Wrong PPID

  await runTest(
    appUrl,
    "wrong-ppid",
    async () => {
      await approveMeasurements(correctMeasurements);
      await approvePpids(wrongPpid);
    },
    async (result) => {
      const registered = await isAgentRegistered(result.agentAccountId);
      if (registered) {
        throw new Error("Agent should not be registered");
      }

      // Verify registrationError contains PPID not in allowed list custom error
      const registrationError = result.registrationError || "";
      if (
        !registrationError.toLowerCase().includes("ppid") ||
        !registrationError
          .toLowerCase()
          .includes("not in the allowed ppids list")
      ) {
        throw new Error(
          `Expected error about PPID not in allowed list, got: ${registrationError}`,
        );
      }

      // Verify callError contains "Agent not registered"
      const callError = result.callError || "";
      if (!callError.includes("Agent not registered")) {
        throw new Error(
          `Expected callError to contain 'Agent not registered', got: ${callError}`,
        );
      }

      // Cleanup: Remove measurements and wrong PPID
      await removeMeasurements(correctMeasurements);
      await removePpids(wrongPpid);
    },
  );
}

// Test 6: Can't submit attestation from different account ID
async function test6(appUrl) {
  const correctMeasurements = getCorrectMeasurements();
  const correctPpids = await getCorrectPpids();

  await runTest(
    appUrl,
    "different-account-id",
    async () => {
      await approveMeasurements(correctMeasurements);
      await approvePpids(correctPpids);
    },
    async (result) => {
      // Verify registrationError matches WrongHash format with report_data
      const registrationError = result.registrationError || "";
      if (
        !registrationError.match(
          /wrong report_data hash \(found .+ expected .+\)/i,
        )
      ) {
        throw new Error(
          `Expected WrongHash error with report_data, got: ${registrationError}`,
        );
      }

      // Verify callError contains "Agent not registered"
      const callError = result.callError || "";
      if (!callError.includes("Agent not registered")) {
        throw new Error(
          `Expected callError to contain 'Agent not registered', got: ${callError}`,
        );
      }

      // Cleanup: Remove measurements and PPIDs
      await removeMeasurements(correctMeasurements);
      await removePpids(correctPpids);
    },
  );
}

// Test 7: Can't do stuff if measurements are removed
async function test7(appUrl) {
  const correctMeasurements = getCorrectMeasurements();
  const correctPpids = await getCorrectPpids();

  console.log(`\n${"=".repeat(70)}`);
  console.log(`Running test: measurements-removed`);
  console.log("=".repeat(70));

  try {
    // Step 1: Approve measurements and PPIDs
    await approveMeasurements(correctMeasurements);
    await approvePpids(correctPpids);
    await new Promise((res) => setTimeout(res, 2000));

    // Step 2: Register the agent (should succeed)
    const registerUrl = `${appUrl}/test/register-agent/measurements-removed`;
    console.log(`Registering agent: ${registerUrl}`);
    const registerResponse = await fetch(registerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (!registerResponse.ok) {
      const errorText = await registerResponse.text();
      throw new Error(
        `Failed to register agent: HTTP ${registerResponse.status}: ${errorText}`,
      );
    }

    const registerResult = await registerResponse.json();
    if (!registerResult.success || registerResult.registrationError) {
      throw new Error(
        `Registration should have succeeded, got error: ${registerResult.registrationError || "Unknown error"}`,
      );
    }

    // Step 3: Remove measurements (this is the test scenario)
    await removeMeasurements(correctMeasurements);
    await new Promise((res) => setTimeout(res, 2000));

    // Step 4: Try to make a call (should fail because measurements were removed)
    const result = await callTestEndpoint(appUrl, "measurements-removed");

    // Verify error contains InvalidMeasurements reason (from AgentRemovalReason)
    const errorMsg = result.callError || "";
    if (!errorMsg.includes("InvalidMeasurements")) {
      throw new Error(
        `Expected error with reason 'InvalidMeasurements', got: ${errorMsg}`,
      );
    }

    // Verify agent was removed from the contract's agent map
    await new Promise((res) => setTimeout(res, 2000));
    const agentStillRegistered = await isAgentRegistered(result.agentAccountId);
    if (agentStillRegistered) {
      throw new Error(
        `Expected agent ${result.agentAccountId} to be removed from map after request_signature, but agent is still registered`,
      );
    }

    // Cleanup: Remove PPIDs
    await removePpids(correctPpids);

    console.log(`✓ Test measurements-removed passed`);
    return true;
  } catch (error) {
    console.error(`✗ Test measurements-removed failed: ${error.message}`);
    throw error;
  }
}

// Test 8: Can't do stuff if PPID is removed
async function test8(appUrl) {
  const correctMeasurements = getCorrectMeasurements();
  const correctPpids = await getCorrectPpids();

  console.log(`\n${"=".repeat(70)}`);
  console.log(`Running test: ppid-removed`);
  console.log("=".repeat(70));

  try {
    // Step 1: Approve measurements and PPIDs
    await approveMeasurements(correctMeasurements);
    await approvePpids(correctPpids);
    await new Promise((res) => setTimeout(res, 2000));

    // Step 2: Register the agent (should succeed)
    const registerUrl = `${appUrl}/test/register-agent/ppid-removed`;
    console.log(`Registering agent: ${registerUrl}`);
    const registerResponse = await fetch(registerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (!registerResponse.ok) {
      const errorText = await registerResponse.text();
      throw new Error(
        `Failed to register agent: HTTP ${registerResponse.status}: ${errorText}`,
      );
    }

    const registerResult = await registerResponse.json();
    if (!registerResult.success || registerResult.registrationError) {
      throw new Error(
        `Registration should have succeeded, got error: ${registerResult.registrationError || "Unknown error"}`,
      );
    }

    // Step 3: Remove PPID (this is the test scenario)
    await removePpids(correctPpids);
    await new Promise((res) => setTimeout(res, 2000));

    // Step 4: Try to make a call (should fail because PPID was removed)
    const result = await callTestEndpoint(appUrl, "ppid-removed");

    // Verify error contains InvalidPpid reason (from AgentRemovalReason)
    const errorMsg = result.callError || "";
    if (!errorMsg.includes("InvalidPpid")) {
      throw new Error(
        `Expected error with reason 'InvalidPpid', got: ${errorMsg}`,
      );
    }

    // Verify agent was removed from the contract's agent map
    await new Promise((res) => setTimeout(res, 2000));
    const agentStillRegistered = await isAgentRegistered(result.agentAccountId);
    if (agentStillRegistered) {
      throw new Error(
        `Expected agent ${result.agentAccountId} to be removed from map after request_signature, but agent is still registered`,
      );
    }

    // Cleanup: Remove measurements
    await removeMeasurements(correctMeasurements);

    console.log(`✓ Test ppid-removed passed`);
    return true;
  } catch (error) {
    console.error(`✗ Test ppid-removed failed: ${error.message}`);
    throw error;
  }
}

// Test 10: Attestation expiration - set expiration to 10s; TEE registers, waits 12s, then request_signature fails with ExpiredAttestation
async function test10(appUrl) {
  const correctMeasurements = getCorrectMeasurements();
  const correctPpids = await getCorrectPpids();

  console.log(`\n${"=".repeat(70)}`);
  console.log(`Running test: attestation-expired`);
  console.log("=".repeat(70));

  try {
    // Step 1: Update attestation expiration to 10 seconds (10000 ms)
    await updateAttestationExpirationTime(10000);
    await new Promise((res) => setTimeout(res, 2000));

    // Step 2: Approve measurements and PPIDs
    await approveMeasurements(correctMeasurements);
    await approvePpids(correctPpids);
    await new Promise((res) => setTimeout(res, 2000));

    // Step 3: Call attestation-expired - TEE registers, waits 12s, then attempts request_signature (call takes ~12+ sec)
    const result = await callTestEndpoint(appUrl, "attestation-expired");

    if (result.registrationError) {
      throw new Error(
        `Registration should have succeeded, got error: ${result.registrationError}`,
      );
    }

    // Step 4: Verify error contains ExpiredAttestation reason (from AgentRemovalReason)
    const errorMsg = result.callError || "";
    if (!errorMsg.includes("ExpiredAttestation")) {
      throw new Error(
        `Expected error with reason 'ExpiredAttestation', got: ${errorMsg}`,
      );
    }

    // Step 5: Verify agent was removed from the contract's agent map
    await new Promise((res) => setTimeout(res, 2000));
    const agentStillRegistered = await isAgentRegistered(result.agentAccountId);
    if (agentStillRegistered) {
      throw new Error(
        `Expected agent ${result.agentAccountId} to be removed from map after request_signature, but agent is still registered`,
      );
    }

    // Cleanup: Restore expiration to 100 seconds (for other tests if any run after)
    await updateAttestationExpirationTime(100000);
    await removeMeasurements(correctMeasurements);
    await removePpids(correctPpids);

    console.log(`✓ Test attestation-expired passed`);
    return true;
  } catch (error) {
    console.error(`✗ Test attestation-expired failed: ${error.message}`);
    throw error;
  }
}

// Test 11: Full operations with errors + private key leak detection
async function test11(appUrl) {
  const correctMeasurements = getCorrectMeasurements();
  const correctPpids = await getCorrectPpids();

  await runTest(
    appUrl,
    "full-operations-with-errors",
    async () => {
      await approveMeasurements(correctMeasurements);
      await approvePpids(correctPpids);
    },
    async (result) => {
      if (result.error) {
        throw new Error(`Test error: ${result.error}`);
      }
      if (!result.success) {
        throw new Error(
          `Expected success, got: ${JSON.stringify(result.operations)}`,
        );
      }
      if (result.leakedInConsole) {
        throw new Error(
          "PRIVATE KEY LEAK: Private key detected in console output",
        );
      }
      if (result.leakedInResponse) {
        throw new Error("PRIVATE KEY LEAK: Private key detected in response");
      }
      if (result.operations.fund1Million.ok) {
        throw new Error("Expected fund(1000000) to fail, but it succeeded");
      }
      if (result.operations.callNonexistent.ok) {
        throw new Error(
          "Expected call(nonexistent_method_xyz) to fail, but it succeeded",
        );
      }

      await removeMeasurements(correctMeasurements);
      await removePpids(correctPpids);
    },
    { checkForPrivateKeyLeak: true },
  );
}

// Test 9: Verify that two agent instances generate different private keys
async function test9(appUrl) {
  const correctMeasurements = getCorrectMeasurements();
  const correctPpids = await getCorrectPpids();

  await runTest(
    appUrl,
    "unique-keys",
    async () => {
      await approveMeasurements(correctMeasurements);
      await approvePpids(correctPpids);
    },
    async (result) => {
      // Verify all keys are unique
      if (!result.allKeysUnique) {
        throw new Error(
          "Expected all keys to be unique, but duplicates were found",
        );
      }

      // Verify each agent has 3 keys
      if (!result.agent1Keys || result.agent1Keys.length !== 3) {
        throw new Error(
          `Agent 1 should have 3 keys, got ${result.agent1Keys?.length || 0}`,
        );
      }

      if (!result.agent2Keys || result.agent2Keys.length !== 3) {
        throw new Error(
          `Agent 2 should have 3 keys, got ${result.agent2Keys?.length || 0}`,
        );
      }

      // Cleanup: Remove measurements and PPIDs
      await removeMeasurements(correctMeasurements);
      await removePpids(correctPpids);
    },
  );
}

// Main execution
async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("Starting Integration Tests");
  console.log("=".repeat(70));

  // Update .env file with generated contract ID
  updateEnvFile();

  // Deploy contract to testnet (skip if SKIP_CONTRACT_DEPLOYMENT is true)
  if (!SKIP_CONTRACT_DEPLOYMENT) {
    console.log("\nDeploying contract to testnet...");
    await createContractAccount();
    await deployContract();
    await initializeContract();
    console.log("✓ Contract deployment complete\n");
  } else {
    console.log(
      "\n⚠ Skipping contract deployment (SKIP_CONTRACT_DEPLOYMENT=true)\n",
    );
  }

  // Deploy to Phala or use provided endpoint
  let appUrl;
  if (SKIP_PHALA_DEPLOYMENT) {
    console.log("⚠ Skipping Phala deployment (TEST_APP_URL provided)");
    appUrl = TEST_APP_URL.trim();
    console.log(`✓ Using provided app URL: ${appUrl}`);
  } else {
    // Build, push, and update docker-compose.yaml with the test image
    console.log("\nBuilding and pushing test image...");
    await buildAndPushTestImage();
    console.log("✓ Test image built and pushed\n");

    console.log("Deploying test image to Phala...");
    const appId = await deployToPhala();
    const appUrls = await getAppUrl(appId);
    if (!appUrls || appUrls.length === 0) {
      throw new Error("Failed to get app URL from Phala");
    }
    appUrl = appUrls[0].app;
    console.log(`✓ App deployed at: ${appUrl}`);
  }

  // Wait for the app to be ready using heartbeat
  await waitForAppReady(appUrl);

  const tests = [
    { name: "Test 1: Successful registration", fn: test1 },
    { name: "Test 2: Wrong measurements (RTMR2)", fn: test2 },
    { name: "Test 3: Wrong key provider", fn: test3 },
    { name: "Test 4: Wrong app compose", fn: test4 },
    { name: "Test 5: Wrong PPID", fn: test5 },
    { name: "Test 6: Different account ID", fn: test6 },
    { name: "Test 7: Measurements removed", fn: test7 },
    { name: "Test 8: PPID removed", fn: test8 },
    { name: "Test 9: Unique keys across agent instances", fn: test9 },
    { name: "Test 10: Attestation expiration", fn: test10 },
    {
      name: "Test 11: Full operations with errors + leak detection",
      fn: test11,
    },
  ];

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i];
    try {
      await test.fn(appUrl);

      // Add 1 second delay between tests (except after the last one)
      if (i < tests.length - 1) {
        await new Promise((res) => setTimeout(res, 1000));
      }
    } catch (error) {
      console.error(`\n✗ ${test.name} FAILED: ${error.message}`);
      throw error;
    }
  }

  console.log("\n✓ All tests passed!");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
