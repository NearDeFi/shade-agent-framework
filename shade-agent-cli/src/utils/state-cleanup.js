import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { tgasToGas } from "./near.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(__dirname, "../assets/state_cleanup.wasm");

// Gas-aware batching
//
// viewContractState returns each storage entry's key AND value (both
// base64-encoded). NEAR's storage_remove host function has a published
// gas cost that scales with key bytes and value bytes, so we can predict
// per-key gas before sending. Each batch is packed up to TARGET_GAS_PER_CALL,
// leaving headroom under the 300 Tgas per-tx cap. The +30% safety factor
// covers wasm execution (the contract's loop + base64 decode) and JSON
// arg parsing on top of the host-function cost.
//
// On a the rare unexpected failure, we sleep
// 1s and retry the same batch once. A second failure red+exits.
//
// MAX_CALLS caps the per-round batch count; if planning would exceed it,
// we bail before sending anything.
const STORAGE_REMOVE_BASE = 53_473_030_500n;
const STORAGE_REMOVE_KEY_BYTE = 38_220_384n;
const STORAGE_REMOVE_RET_VALUE_BYTE = 11_531_556n;
const SAFETY_FACTOR_PCT = 130n;
const TARGET_GAS_PER_CALL = 250_000_000_000_000n;
const ATTACHED_GAS_TGAS = 300;
const MAX_CALLS = 10;
const STEP_SLEEP_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Decoded byte length of a canonical base64 string, without allocating the
// decoded buffer. view_state returns padded base64 with no whitespace, so
// the formula `(len * 3 / 4) - padding` is exact.
function base64DecodedByteLength(value) {
  const paddingMatch = value.match(/=+$/);
  const paddingLength = paddingMatch ? paddingMatch[0].length : 0;
  return (value.length * 3) / 4 - paddingLength;
}

export function estimateKeyGas(keyB64, valueB64) {
  const keyBytes = BigInt(base64DecodedByteLength(keyB64));
  const valBytes = BigInt(base64DecodedByteLength(valueB64));
  const raw =
    STORAGE_REMOVE_BASE +
    keyBytes * STORAGE_REMOVE_KEY_BYTE +
    valBytes * STORAGE_REMOVE_RET_VALUE_BYTE;
  return (raw * SAFETY_FACTOR_PCT) / 100n;
}

export function planBatches(entries) {
  const batches = [];
  let current = [];
  let currentGas = 0n;
  for (const { key, value } of entries) {
    const est = estimateKeyGas(key, value);
    if (currentGas + est > TARGET_GAS_PER_CALL && current.length > 0) {
      batches.push(current);
      current = [];
      currentGas = 0n;
    }
    current.push(key);
    currentGas += est;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function sendCleanBatch(contractAccount, accountId, keys) {
  return contractAccount.callFunctionRaw({
    contractId: accountId,
    methodName: "clean",
    args: { keys },
    gas: tgasToGas(ATTACHED_GAS_TGAS),
  });
}

export async function wipeContractState(contractAccount) {
  console.log("Contract account already exists, wiping state");

  const provider = contractAccount.provider;
  const accountId = contractAccount.accountId;

  try {
    const wasm = fs.readFileSync(WASM_PATH);
    await contractAccount.deployContract(new Uint8Array(wasm));
    await sleep(STEP_SLEEP_MS);
  } catch (e) {
    if (e.type === "AccessKeyDoesNotExist") {
      console.log(
        chalk.red(
          "Error: You cannot wipe state on a contract account that does not have the same public key as your master account, pick a new unique contract_id or change back to your old master account for which you created the contract account with",
        ),
      );
      process.exit(1);
    }
    console.log(chalk.red(`Error deploying state-cleanup contract: ${e.message}`));
    process.exit(1);
  }

  while (true) {
    let entries;
    try {
      const view = await provider.viewContractState(accountId, "", {
        finality: "final",
      });
      entries = view.values;
    } catch (e) {
      console.log(
        chalk.red(
          `Error: view_state RPC failed for ${accountId} try a different RPC provider or deploy to a new contract: ${e.message}`,
        ),
      );
      process.exit(1);
    }

    if (entries.length === 0) return;

    const batches = planBatches(entries);
    if (batches.length > MAX_CALLS) {
      console.log(
        chalk.red(
          `Error: state-cleanup would need ${batches.length} clean() calls to remove ${entries.length} keys (max ${MAX_CALLS}). Contract state is too large. Deploy to a new contract instead or manually attempt to clean state.`,
        ),
      );
      process.exit(1);
    }

    for (const batch of batches) {
      try {
        await sendCleanBatch(contractAccount, accountId, batch);
      } catch (e) {
        await sleep(STEP_SLEEP_MS);
        try {
          await sendCleanBatch(contractAccount, accountId, batch);
        } catch (e2) {
          console.log(
            chalk.red(
              `Error calling state-cleanup 'clean' (batch of ${batch.length} keys, retried once): ${e2.message}`,
            ),
          );
          process.exit(1);
        }
      }
      await sleep(STEP_SLEEP_MS);
    }
  }
}
