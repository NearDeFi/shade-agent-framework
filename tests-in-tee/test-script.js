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
import { randomBytes } from "crypto";
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
import { deployToPhala as deployToPhalaSdk, createClient } from "../shade-agent-cli/src/utils/phala-deploy.js";
import { wipeContractState } from "../shade-agent-cli/src/utils/state-cleanup.js";
import { deleteContractAccount } from "./teardown-account.js";

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

// Phala Cloud SDK client (same SDK the CLI deploy path uses)
const phalaClient = createClient({ apiKey: PHALA_API_KEY });

// Random per-run slug (6 bytes / 48-bit) so overlapping runs (e.g. on different
// PRs) don't collide on the contract account or Phala app name,
// while keeping the derived account id well within NEAR's 64-char limit.
const RUN_SLUG = randomBytes(6).toString("hex");

// Generate contract ID as subaccount of TESTNET_ACCOUNT_ID
const AGENT_CONTRACT_ID = `shade-test-${RUN_SLUG}.${TESTNET_ACCOUNT_ID}`;
const TEST_APP_NAME = `shade-integration-tests-${RUN_SLUG}`;

// Fail fast if TESTNET_ACCOUNT_ID is long enough to push the derived subaccount
// past NEAR's 64-char account-id limit .
if (AGENT_CONTRACT_ID.length > 64) {
  console.error(
    `Derived contract account id is ${AGENT_CONTRACT_ID.length} chars, over NEAR's 64-char limit:\n  ${AGENT_CONTRACT_ID}\nUse a shorter TESTNET_ACCOUNT_ID.`,
  );
  process.exit(1);
}

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

// Failures are tagged with a category + context so the reporter can name what
// went wrong. Retries stay narrow: connection errors and NEAR nonce conflicts.
const ErrorCategory = {
  CONNECTION: "CONNECTION",
  APP: "APP",
  ASSERTION: "ASSERTION",
  NEAR: "NEAR",
  SETUP: "SETUP",
  UNKNOWN: "UNKNOWN",
};

// Attach a category (first tag wins, so a deep ASSERTION/APP/NEAR throw keeps
// its category when an outer catch re-tags) and merge context for the reporter.
function tagError(error, category, context = {}) {
  const err = error instanceof Error ? error : new Error(String(error));
  if (!err.category) err.category = category;
  // Don't let an undefined value clobber a key an inner throw already set.
  const merged = { ...(err.context || {}) };
  for (const [k, v] of Object.entries(context)) {
    if (v !== undefined) merged[k] = v;
  }
  err.context = merged;
  return err;
}

// Retryable: undici "fetch failed" (TypeError with .cause), an AbortError from
// our timeout, or a socket error code. A bare TypeError is a programmer error.
const CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNRESET",
  "EAI_AGAIN",
  "EPIPE",
]);

function isConnectionError(e) {
  if (e instanceof TypeError) return e.cause !== undefined;
  if (e?.name === "AbortError") return true;
  const code = e?.code ?? e?.cause?.code;
  if (typeof code === "string") {
    return CONNECTION_CODES.has(code) || code.startsWith("UND_ERR_");
  }
  return false;
}

// Retry 404 (warmup), 408/429, and 5xx. The app's crash-envelope 5xx is caught
// before this is consulted.
function isTransientHttpStatus(status) {
  return (
    status === 404 ||
    status === 408 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

// Call a test-app endpoint with connection-only retries + a per-request timeout.
// Returns the parsed body; throws a tagged CONNECTION/APP error.
async function fetchWithRetry(
  url,
  fetchOptions = {},
  {
    test,
    step,
    timeoutMs = 60000,
    maxAttempts = 5,
    delay = 2000,
    checkForPrivateKeyLeak = false,
  } = {},
) {
  const ctx = { url, test, step };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let text;
    try {
      response = await fetch(url, { ...fetchOptions, signal: controller.signal });
      text = await response.text();
    } catch (e) {
      if (isConnectionError(e) && attempt < maxAttempts) {
        console.log(
          `Connection error calling ${url} (attempt ${attempt} of ${maxAttempts}), retrying`,
        );
        await sleep(delay);
        continue;
      }
      // A non-connection fetch throw (bad URL, programmer TypeError) isn't transport.
      throw tagError(
        e,
        isConnectionError(e) ? ErrorCategory.CONNECTION : ErrorCategory.UNKNOWN,
        { ...ctx, attempt },
      );
    } finally {
      clearTimeout(timeoutId);
    }

    // Definitive: a private key in any response body is a leak, never retried.
    if (checkForPrivateKeyLeak && containsPrivateKey(text)) {
      throw tagError(
        new Error(
          `PRIVATE KEY LEAK DETECTED: response from ${url} contains private key patterns`,
        ),
        ErrorCategory.ASSERTION,
        { ...ctx, status: response.status, attempt },
      );
    }

    if (response.ok) {
      try {
        return JSON.parse(text);
      } catch {
        throw tagError(
          new Error(`Could not parse 200 response from ${url}: ${text}`),
          ErrorCategory.APP,
          { ...ctx, status: response.status, attempt },
        );
      }
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }

    // App handler crash (carries a stack) — report it, never retry even on 5xx.
    if (body?.success === false && typeof body.stack === "string") {
      throw tagError(
        new Error(body.error || "Test app handler error"),
        ErrorCategory.APP,
        { ...ctx, status: response.status, remoteStack: body.stack, attempt },
      );
    }

    // Structured registration result (no stack) — a body the caller inspects.
    if (body?.success === false && body.registrationError !== undefined) {
      return body;
    }

    // Deterministic "agent not found" ordering error.
    if (response.status === 400 && body?.success === false) {
      throw tagError(
        new Error(body.error || `HTTP 400: ${text}`),
        ErrorCategory.APP,
        { ...ctx, status: 400, attempt },
      );
    }

    if (isTransientHttpStatus(response.status) && attempt < maxAttempts) {
      await sleep(delay);
      continue;
    }

    throw tagError(
      new Error(`HTTP ${response.status}: ${text}`),
      ErrorCategory.APP,
      { ...ctx, status: response.status, attempt },
    );
  }

  // Unreachable guardrail — every attempt returns or throws.
  throw tagError(
    new Error(`fetchWithRetry exhausted ${maxAttempts} attempts for ${url}`),
    ErrorCategory.UNKNOWN,
    { ...ctx, attempt: maxAttempts },
  );
}

// A nonce conflict is RPC read-after-write lag: a node returns a stale
// access-key nonce, so the next tx reuses one the chain already consumed.
// Re-invoking re-queries it; jittered backoff lets the node catch up.
function isNonceConflict(e) {
  return e?.type === "InvalidNonce" || /nonce/i.test(e?.message ?? "");
}

// `category` lets the caller label an exhausted/non-nonce failure by phase:
// setup-path callers pass SETUP; the in-test owner/admin calls keep NEAR.
async function withNonceRetry(
  fn,
  label,
  { category = ErrorCategory.NEAR, maxAttempts = 5 } = {},
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt < maxAttempts && isNonceConflict(e)) {
        console.log(
          `Nonce conflict on ${label} (attempt ${attempt} of ${maxAttempts}), retrying`,
        );
        await sleep(300 + attempt * 400 + Math.floor(Math.random() * 2000));
        continue;
      }
      throw tagError(e, category, { step: label, attempt });
    }
  }
}

// Build an in-depth, categorized failure report for the top-level handler.
function formatError(error) {
  const rule = "=".repeat(70);
  const category = error?.category ?? ErrorCategory.UNKNOWN;
  const ctx = error?.context ?? {};
  const lines = [rule];
  lines.push(
    `✗ FAILURE [${category}]` +
      (ctx.test ? `  test=${ctx.test}` : "") +
      (ctx.step ? `  step=${ctx.step}` : ""),
  );
  lines.push(rule);
  lines.push(`Reason: ${error?.message ?? String(error)}`);

  if (ctx.url) lines.push(`URL: ${ctx.url}`);
  if (ctx.status !== undefined) lines.push(`HTTP status: ${ctx.status}`);
  if (ctx.attempt !== undefined) lines.push(`Attempts: ${ctx.attempt}`);

  // Gate on the field, not the category — a SETUP/NEAR error can carry these too.
  const code = error?.code ?? error?.cause?.code;
  if (code) lines.push(`Error code: ${code}`);
  if (error?.cause?.message) {
    lines.push(`Underlying cause: ${error.cause.message}`);
  }
  if (error?.type) {
    lines.push(`Error type: ${error.type}`);
  }

  if (ctx.result !== undefined) {
    lines.push("Result object:");
    // Guard the stringify so a non-JSON result can't crash the report itself.
    try {
      lines.push(JSON.stringify(ctx.result, null, 2));
    } catch {
      lines.push(String(ctx.result));
    }
  }

  if (ctx.remoteStack) {
    lines.push("Remote stack (inside TEE):");
    lines.push(ctx.remoteStack);
  }

  if (error?.stack) {
    lines.push("Local stack:");
    lines.push(error.stack);
  }

  lines.push(rule);
  return lines.join("\n");
}

// Create contract account (as subaccount of TESTNET_ACCOUNT_ID)
async function createContractAccount() {
  console.log("Creating contract account...");
  const fundingAmount = 10; // NEAR tokens

  // Buffer to cover transaction fees plus the wipe gas burn (one tx
  // attaching the protocol's max_total_prepaid_gas ≈ 1000 Tgas ≈ 0.1 NEAR
  // at baseline gas price; 2× headroom).
  const FEE_BUFFER = 0.2;
  const requiredBalance = fundingAmount + FEE_BUFFER;
  const masterBalance = await account.getBalance(NEAR);
  const masterBalanceDecimal = parseFloat(NEAR.toDecimal(masterBalance));

  let contractAccountExists = false;
  let contractBalanceDecimal = 0;
  try {
    const state = await contractAccount.getState();
    contractAccountExists = true;
    if (state && state.balance && state.balance.total) {
      contractBalanceDecimal = parseFloat(NEAR.toDecimal(state.balance.total));
    }
  } catch (e) {
    if (e.type !== "AccountDoesNotExist") {
      throw tagError(
        new Error(`Error checking contract account: ${e.message}`),
        ErrorCategory.SETUP,
        { step: "check-contract-account" },
      );
    }
  }

  const totalBalance = masterBalanceDecimal + contractBalanceDecimal;

  if (totalBalance < requiredBalance) {
    throw tagError(
      new Error(
        `Insufficient balance. Master account has ${totalBalance} NEAR but needs ${requiredBalance} NEAR ` +
          `(${fundingAmount} NEAR for contract + ${FEE_BUFFER} NEAR extra for transaction fees and wipe gas)`,
      ),
      ErrorCategory.SETUP,
      { step: "fund-check" },
    );
  }

  if (contractAccountExists) {
    // Wipe contract state instead of deleting (account + balance preserved).
    try {
      await withNonceRetry(
        () => wipeContractState(contractAccount),
        "wipe-contract-state",
        { category: ErrorCategory.SETUP },
      );
      await sleep(2000);
    } catch (e) {
      if (e.type === "AccessKeyDoesNotExist") {
        throw tagError(
          new Error(
            "Cannot wipe contract account state - access key mismatch. " +
              "The contract account was created with a different master account.",
          ),
          ErrorCategory.SETUP,
          { step: "wipe-contract-state" },
        );
      }
      throw tagError(e, ErrorCategory.SETUP, { step: "wipe-contract-state" });
    }

    // Re-fetch the post-wipe balance — cleanup gas burned some of it.
    const postWipeBalance = await contractAccount.getBalance(NEAR);
    const postWipeBalanceDecimal = parseFloat(NEAR.toDecimal(postWipeBalance));
    const topUp = fundingAmount - postWipeBalanceDecimal;
    if (topUp > 0) {
      console.log(`Topping up contract account with ${topUp} NEAR...`);
      try {
        await withNonceRetry(
          () =>
            account.transfer({
              receiverId: AGENT_CONTRACT_ID,
              amount: NEAR.toUnits(topUp.toString()),
            }),
          "topup-contract-account",
          { category: ErrorCategory.SETUP },
        );
        await sleep(2000);
      } catch (e) {
        throw tagError(e, ErrorCategory.SETUP, {
          step: "topup-contract-account",
        });
      }
    }
    console.log(`✓ Contract account state wiped: ${AGENT_CONTRACT_ID}`);
    return;
  }

  console.log("Contract account does not exist, creating it");
  try {
    const publicKey = await account.getSigner().getPublicKey();
    await withNonceRetry(
      () =>
        account.createAccount(
          AGENT_CONTRACT_ID,
          publicKey,
          NEAR.toUnits(fundingAmount),
        ),
      "create-account",
      { category: ErrorCategory.SETUP },
    );
    await sleep(2000);
    console.log(`✓ Contract account created: ${AGENT_CONTRACT_ID}`);
  } catch (e) {
    throw tagError(e, ErrorCategory.SETUP, { step: "create-account" });
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
    throw tagError(
      new Error(
        `WASM file not found at ${wasmPath}. Please build the contract first.`,
      ),
      ErrorCategory.SETUP,
      { step: "deploy-contract" },
    );
  }

  try {
    const wasmBytes = fs.readFileSync(wasmPath);
    await withNonceRetry(
      () => contractAccount.deployContract(new Uint8Array(wasmBytes)),
      "deploy-contract",
      { category: ErrorCategory.SETUP },
    );
    await sleep(2000);
    console.log("✓ Contract deployed");
  } catch (e) {
    throw tagError(e, ErrorCategory.SETUP, { step: "deploy-contract" });
  }
}

// Initialize contract
async function initializeContract() {
  console.log("Initializing contract...");

  const initArgs = {
    requires_tee: true,
    attestation_expiration_time_ms: "100000", // 100 seconds in milliseconds (as U64 string)
    // The contract owns itself so owner-gated calls are signed by the contract
    // account (its own nonce), not the shared parent key — lets runs overlap.
    owner_id: AGENT_CONTRACT_ID,
    mpc_contract_id: "v1.signer-prod.testnet", // testnet MPC contract
  };

  try {
    await withNonceRetry(
      () =>
        contractAccount.callFunction({
          contractId: AGENT_CONTRACT_ID,
          methodName: "new",
          args: initArgs,
          gas: tgasToGas(30),
        }),
      "initialize-contract",
      { category: ErrorCategory.SETUP },
    );
    await sleep(2000);
    console.log("✓ Contract initialized");
  } catch (e) {
    throw tagError(e, ErrorCategory.SETUP, { step: "initialize-contract" });
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

// Deploy to Phala using the same SDK flow as shade-agent-cli
async function deployToPhala() {
  const composePath = resolve(__dirname, "docker-compose.yaml");
  const envFilePath = resolve(__dirname, ".env");
  const allowedEnvs = extractAllowedEnvs(composePath);

  const deployResult = await deployToPhalaSdk({
    appName: TEST_APP_NAME,
    apiKey: PHALA_API_KEY,
    composePath,
    envFilePath,
    allowedEnvKeys: allowedEnvs,
    dstackVersion: "0.5.8",
    instanceType: "tdx.small",
    publicLogs: true,
    publicSysinfo: true,
  });

  if (!deployResult.success) {
    throw new Error("Phala deployment failed");
  }

  if (deployResult.dashboard_url) {
    console.log(`\nPhala Application Dashboard URL: ${deployResult.dashboard_url}`);
  }

  return deployResult.vm_uuid;
}

// Delete the Phala CVM to avoid leaking a paid TEE instance. Idempotent: a 404
// (already deleted) counts as success. Uses the SDK's safeDeleteCvm, which
// returns a { success, error } result instead of throwing. The whole body is
// also wrapped in try/catch so an unexpected throw (SDK or fs.rmSync) can never
// escape — teardown runs in a finally and must never mask the real failure.
async function deletePhalaApp(appId) {
  if (!appId) return;
  console.log(`\nTearing down Phala CVM ${appId}...`);
  try {
    const { success, error } = await phalaClient.safeDeleteCvm({ uuid: appId });
    if (success || error?.status === 404) {
      console.log(`✓ Phala CVM ${appId} torn down`);
      fs.rmSync(resolve(__dirname, ".cvm-id"), { force: true });
    } else {
      console.error(
        `⚠ Failed to tear down Phala CVM ${appId}: ${error?.message ?? "unknown error"}`,
      );
    }
  } catch (e) {
    console.error(`⚠ Error tearing down Phala CVM ${appId}: ${e.message}`);
  }
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
        if (Array.isArray(data.endpoints)) {
          const validUrls = data.endpoints.filter(
            (u) => u.app && u.app.trim() !== "",
          );
          if (validUrls.length > 0) {
            console.log(`\nYour app is live at:`);
            validUrls.forEach((urlObj, index) => {
              console.log(`  ${index + 1}. ${urlObj.app}`);
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
  await withNonceRetry(
    () =>
      contractAccount.callFunction({
        contractId: AGENT_CONTRACT_ID,
        methodName: "approve_measurements",
        args: { measurements },
        gas: tgasToGas(30),
      }),
    "approve_measurements",
  );
}

// Remove measurements
async function removeMeasurements(measurements) {
  console.log("Removing measurements...");
  await withNonceRetry(
    () =>
      contractAccount.callFunction({
        contractId: AGENT_CONTRACT_ID,
        methodName: "remove_measurements",
        args: { measurements },
        gas: tgasToGas(30),
      }),
    "remove_measurements",
  );
}

// Approve PPIDs
async function approvePpids(ppids) {
  console.log("Approving PPIDs...");
  await withNonceRetry(
    () =>
      contractAccount.callFunction({
        contractId: AGENT_CONTRACT_ID,
        methodName: "approve_ppids",
        args: { ppids },
        gas: tgasToGas(30),
      }),
    "approve_ppids",
  );
}

// Remove PPIDs
async function removePpids(ppids) {
  console.log("Removing PPIDs...");
  await withNonceRetry(
    () =>
      contractAccount.callFunction({
        contractId: AGENT_CONTRACT_ID,
        methodName: "remove_ppids",
        args: { ppids },
        gas: tgasToGas(30),
      }),
    "remove_ppids",
  );
}

// Update attestation expiration time (owner only). Pass ms as number or string.
async function updateAttestationExpirationTime(ms) {
  const msStr = String(ms);
  console.log(`Updating attestation expiration to ${msStr} ms...`);
  await withNonceRetry(
    () =>
      contractAccount.callFunction({
        contractId: AGENT_CONTRACT_ID,
        methodName: "update_attestation_expiration_time",
        args: { attestation_expiration_time_ms: msStr },
        gas: tgasToGas(30),
      }),
    "update_attestation_expiration_time",
  );
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

  return fetchWithRetry(
    url,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    { test: testName, step: "call-test-endpoint", checkForPrivateKeyLeak },
  );
}

// Get correct measurements
function getCorrectMeasurements() {
  const composePath = resolve(__dirname, "docker-compose.yaml");
  return getMeasurements(true, composePath, "0.5.8", "tdx.small", {
    publicLogs: true,
    publicSysinfo: true,
  });
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
  const wrongAppComposeHash = calculateAppComposeHash(composePath, {
    allowedEnvsOverride: modifiedEnvs,
    publicLogs: true,
    publicSysinfo: true,
  });

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

  let result;
  try {
    // Setup
    if (setupFn) {
      await setupFn();
      // Wait a bit for setup to propagate
      await new Promise((res) => setTimeout(res, 2000));
    }

    // Call test endpoint
    result = await callTestEndpoint(appUrl, testName, options);

    // Verify (script does all error checking)
    if (verifyFn) {
      await verifyFn(result);
    }

    console.log(`✓ Test ${testName} passed`);
    return true;
  } catch (error) {
    // First tag wins; a bare verify-fn assertion becomes ASSERTION + result.
    throw tagError(error, ErrorCategory.ASSERTION, { test: testName, result });
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

  let result;
  try {
    // Step 1: Approve measurements and PPIDs
    await approveMeasurements(correctMeasurements);
    await approvePpids(correctPpids);
    await new Promise((res) => setTimeout(res, 2000));

    // Step 2: Register the agent (should succeed)
    const registerUrl = `${appUrl}/test/register-agent/measurements-removed`;
    console.log(`Registering agent: ${registerUrl}`);
    const registerResult = await fetchWithRetry(
      registerUrl,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      { test: "measurements-removed", step: "register-agent" },
    );
    if (!registerResult.success || registerResult.registrationError) {
      throw tagError(
        new Error(
          `Registration should have succeeded, got error: ${registerResult.registrationError || "Unknown error"}`,
        ),
        ErrorCategory.ASSERTION,
        {
          test: "measurements-removed",
          step: "register-agent",
          result: registerResult,
        },
      );
    }

    // Step 3: Remove measurements (this is the test scenario)
    await removeMeasurements(correctMeasurements);
    await new Promise((res) => setTimeout(res, 2000));

    // Step 4: Try to make a call (should fail because measurements were removed)
    result = await callTestEndpoint(appUrl, "measurements-removed");

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
    throw tagError(error, ErrorCategory.ASSERTION, {
      test: "measurements-removed",
      result,
    });
  }
}

// Test 8: Can't do stuff if PPID is removed
async function test8(appUrl) {
  const correctMeasurements = getCorrectMeasurements();
  const correctPpids = await getCorrectPpids();

  console.log(`\n${"=".repeat(70)}`);
  console.log(`Running test: ppid-removed`);
  console.log("=".repeat(70));

  let result;
  try {
    // Step 1: Approve measurements and PPIDs
    await approveMeasurements(correctMeasurements);
    await approvePpids(correctPpids);
    await new Promise((res) => setTimeout(res, 2000));

    // Step 2: Register the agent (should succeed)
    const registerUrl = `${appUrl}/test/register-agent/ppid-removed`;
    console.log(`Registering agent: ${registerUrl}`);
    const registerResult = await fetchWithRetry(
      registerUrl,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      { test: "ppid-removed", step: "register-agent" },
    );
    if (!registerResult.success || registerResult.registrationError) {
      throw tagError(
        new Error(
          `Registration should have succeeded, got error: ${registerResult.registrationError || "Unknown error"}`,
        ),
        ErrorCategory.ASSERTION,
        {
          test: "ppid-removed",
          step: "register-agent",
          result: registerResult,
        },
      );
    }

    // Step 3: Remove PPID (this is the test scenario)
    await removePpids(correctPpids);
    await new Promise((res) => setTimeout(res, 2000));

    // Step 4: Try to make a call (should fail because PPID was removed)
    result = await callTestEndpoint(appUrl, "ppid-removed");

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
    throw tagError(error, ErrorCategory.ASSERTION, {
      test: "ppid-removed",
      result,
    });
  }
}

// Test 10: Attestation expiration - set expiration to 10s; TEE registers, waits 12s, then request_signature fails with ExpiredAttestation
async function test10(appUrl) {
  const correctMeasurements = getCorrectMeasurements();
  const correctPpids = await getCorrectPpids();

  console.log(`\n${"=".repeat(70)}`);
  console.log(`Running test: attestation-expired`);
  console.log("=".repeat(70));

  let result;
  try {
    // Step 1: Update attestation expiration to 10 seconds (10000 ms)
    await updateAttestationExpirationTime(10000);
    await new Promise((res) => setTimeout(res, 2000));

    // Step 2: Approve measurements and PPIDs
    await approveMeasurements(correctMeasurements);
    await approvePpids(correctPpids);
    await new Promise((res) => setTimeout(res, 2000));

    // Step 3: Call attestation-expired - TEE registers, waits 12s, then attempts request_signature (call takes ~12+ sec)
    result = await callTestEndpoint(appUrl, "attestation-expired");

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
    throw tagError(error, ErrorCategory.ASSERTION, {
      test: "attestation-expired",
      result,
    });
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

      // Verify each agent has 3 keys (the TEE returns counts, never the keys)
      if (result.agent1KeyCount !== 3) {
        throw new Error(
          `Agent 1 should have 3 keys, got ${result.agent1KeyCount ?? 0}`,
        );
      }

      if (result.agent2KeyCount !== 3) {
        throw new Error(
          `Agent 2 should have 3 keys, got ${result.agent2KeyCount ?? 0}`,
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

  // Deploy to Phala and run the tests. The whole block is wrapped so the
  // `finally` always tears down the CVM and the contract account this run
  // provisioned, on success or failure, so overlapping runs don't leak a paid
  // Phala TEE instance or a funded testnet account.
  let appUrl;
  let appId = null;
  let setupDone = false;
  try {
    // Deploy contract to testnet.
    console.log("\nDeploying contract to testnet...");
    // Persist the account id before creating it, so a CI teardown step can
    // delete it even if this process is killed mid-create.
    try {
      fs.writeFileSync(resolve(__dirname, ".contract-id"), AGENT_CONTRACT_ID);
    } catch (e) {
      console.error(`⚠ Could not write .contract-id: ${e.message}`);
    }
    await createContractAccount();
    await deployContract();
    await initializeContract();
    console.log("✓ Contract deployment complete\n");

    // Build, push, and update docker-compose.yaml with the test image
    console.log("\nBuilding and pushing test image...");
    await buildAndPushTestImage();
    console.log("✓ Test image built and pushed\n");

    console.log("Deploying test image to Phala...");
    appId = await deployToPhala();
    // Persist the CVM id so a CI teardown step can delete it even if this
    // process is killed before the `finally` below runs.
    try {
      fs.writeFileSync(resolve(__dirname, ".cvm-id"), String(appId));
    } catch (e) {
      console.error(`⚠ Could not write .cvm-id: ${e.message}`);
    }
    const appUrls = await getAppUrl(appId);
    if (!appUrls || appUrls.length === 0) {
      throw new Error("Failed to get app URL from Phala");
    }
    appUrl = appUrls[0].app;
    console.log(`✓ App deployed at: ${appUrl}`);

    // Wait for the app to be ready using heartbeat
    await waitForAppReady(appUrl);
    // Past here is the test phase; the catch below tags only setup failures.
    setupDone = true;

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
      await tests[i].fn(appUrl);

      // Add 1 second delay between tests (except after the last one)
      if (i < tests.length - 1) {
        await new Promise((res) => setTimeout(res, 1000));
      }
    }

    console.log("\n✓ All tests passed!");
  } catch (e) {
    // Untagged failures before readiness are setup/infra — tag them SETUP.
    throw setupDone ? e : tagError(e, ErrorCategory.SETUP, {});
  } finally {
    // Tear down what this run provisioned: the Phala CVM, then the per-run
    // contract account (refunding the parent). Both are idempotent and neither
    // throws, so this is safe even if an early failure left them half-created
    // (appId stays null until the CVM exists, making deletePhalaApp a no-op).
    await deletePhalaApp(appId);
    await deleteContractAccount(contractAccount, TESTNET_ACCOUNT_ID);
  }
}

main().catch((error) => {
  console.error(formatError(error));
  process.exit(1);
});
