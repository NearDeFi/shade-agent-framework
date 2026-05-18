import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { serialize } from "borsh";
import { actionCreators, SCHEMA } from "@near-js/transactions";

// Single-transaction wipe. Read state once, fetch protocol constants live,
// preflight gas + tx-size against the chain caps, then send one tx that
// deploys the cleanup wasm and calls clean(keys) in the same receipt.
// Mirrors contract-cleaner-rust/extension/src/{lib,plan,cleanup}.rs.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.join(__dirname, "../assets/state_cleanup.wasm");

const SAFETY_FACTOR_PCT = 130n;
const TX_WRAPPER_OVERHEAD_BYTES = 2560;
const TX_SIZE_BUFFER_BYTES = 100 * 1024;
const POST_TX_SLEEP_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Decoded byte length of a canonical base64 string, without allocating the
// decoded buffer. view_state returns padded base64 with no whitespace, so
// the formula `(len * 3 / 4) - padding` is exact.
function base64DecodedByteLength(value) {
  const paddingMatch = value.match(/=+$/);
  const paddingLength = paddingMatch ? paddingMatch[0].length : 0;
  return (value.length * 3) / 4 - paddingLength;
}

// Coerce a protocol_config gas/limit field that nearcore may serialize as a
// JSON number OR a stringified integer. Red-exits if the shape is something
// else so a future protocol-config change fails loudly instead of silently.
function toBigInt(v, fieldName) {
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^[0-9]+$/.test(v)) return BigInt(v);
  console.log(
    chalk.red(
      `Error: protocol_config field ${fieldName} has unexpected shape (got ${typeof v}: ${JSON.stringify(v)})`,
    ),
  );
  process.exit(1);
}

export function parseProtocolConfig(cfg) {
  const wasm = cfg?.runtime_config?.wasm_config;
  if (!wasm) {
    console.log(
      chalk.red(
        "Error: protocol_config missing runtime_config.wasm_config",
      ),
    );
    process.exit(1);
  }
  const ext = wasm.ext_costs ?? {};
  const lim = wasm.limit_config ?? {};
  return {
    storageRemoveBase: toBigInt(ext.storage_remove_base, "ext_costs.storage_remove_base"),
    storageRemoveKeyByte: toBigInt(ext.storage_remove_key_byte, "ext_costs.storage_remove_key_byte"),
    storageRemoveRetValueByte: toBigInt(
      ext.storage_remove_ret_value_byte,
      "ext_costs.storage_remove_ret_value_byte",
    ),
    maxTransactionSize: toBigInt(lim.max_transaction_size, "limit_config.max_transaction_size"),
    maxTotalPrepaidGas: toBigInt(lim.max_total_prepaid_gas, "limit_config.max_total_prepaid_gas"),
  };
}

export function estimateKeyGas(keyB64, valueB64, c) {
  const keyBytes = BigInt(base64DecodedByteLength(keyB64));
  const valBytes = BigInt(base64DecodedByteLength(valueB64));
  const raw =
    c.storageRemoveBase +
    keyBytes * c.storageRemoveKeyByte +
    valBytes * c.storageRemoveRetValueByte;
  return (raw * SAFETY_FACTOR_PCT) / 100n;
}

export function estimateTotalGas(entries, c) {
  let sum = 0n;
  for (const { key, value } of entries) sum += estimateKeyGas(key, value, c);
  return sum;
}

export function estimateTransactionSize(actions, accountId) {
  const bytes = serialize({ array: { type: SCHEMA.Action } }, actions);
  return bytes.length + TX_WRAPPER_OVERHEAD_BYTES + 2 * accountId.length;
}

async function fetchProtocolConstantsOrExit(provider) {
  try {
    const cfg = await provider.experimental_protocolConfig({ finality: "final" });
    return parseProtocolConfig(cfg);
  } catch (e) {
    console.log(chalk.red(`Error: fetching protocol_config failed: ${e.message}`));
    process.exit(1);
  }
}

async function readStateOrExit(provider, accountId) {
  try {
    const view = await provider.viewContractState(accountId, "", {
      finality: "final",
    });
    return view.values;
  } catch (e) {
    if (e?.type === "TooLargeContractState") {
      console.log(
        chalk.red(
          `Error: account state on ${accountId} is too large for this RPC's view_state cap. Configure a different RPC and retry, or deploy to a new contract.`,
        ),
      );
      process.exit(1);
    }
    console.log(
      chalk.red(
        `Error: view_state RPC failed for ${accountId}: ${e.message}`,
      ),
    );
    process.exit(1);
  }
}

export async function wipeContractState(contractAccount) {
  const provider = contractAccount.provider;
  const accountId = contractAccount.accountId;

  const entries = await readStateOrExit(provider, accountId);
  if (entries.length === 0) {
    console.log("Contract account already exists with no state to wipe");
    return;
  }
  const consts = await fetchProtocolConstantsOrExit(provider);

  const estGas = estimateTotalGas(entries, consts);
  if (estGas > consts.maxTotalPrepaidGas) {
    console.log(
      chalk.red(
        `Error: state is too large to wipe in a single transaction ` +
          `(estimated ${(Number(estGas) / 1e12).toFixed(1)} Tgas, budget ${(Number(consts.maxTotalPrepaidGas) / 1e12).toFixed(0)} Tgas). ` +
          `Deploy to a new contract instead.`,
      ),
    );
    process.exit(1);
  }

  const wasm = new Uint8Array(fs.readFileSync(WASM_PATH));
  // view_state returns each entry's key already base64-encoded, which is
  // exactly the form clean(keys: Vec<Base64VecU8>) expects on the JSON side.
  const keys = entries.map((e) => e.key);
  const actions = [
    actionCreators.deployContract(wasm),
    actionCreators.functionCall("clean", { keys }, consts.maxTotalPrepaidGas, 0n),
  ];

  const txSize = BigInt(estimateTransactionSize(actions, accountId));
  const txSizeBudget = consts.maxTransactionSize - BigInt(TX_SIZE_BUFFER_BYTES);
  if (txSize > txSizeBudget) {
    console.log(
      chalk.red(
        `Error: wipe transaction would exceed the protocol max transaction size ` +
          `(${txSize} B > ${txSizeBudget} B budget; protocol cap ${consts.maxTransactionSize} B with ${TX_SIZE_BUFFER_BYTES} B safety buffer). ` +
          `Deploy to a new contract instead.`,
      ),
    );
    process.exit(1);
  }

  console.log("Contract account already exists, wiping state");
  try {
    await contractAccount.signAndSendTransaction({
      receiverId: accountId,
      actions,
    });
  } catch (e) {
    if (e?.type === "AccessKeyDoesNotExist") {
      console.log(
        chalk.red(
          "Error: You cannot wipe state on a contract account that does not have the same public key as your master account, pick a new unique contract_id or change back to your old master account for which you created the contract account with",
        ),
      );
      process.exit(1);
    }
    console.log(chalk.red(`Error wiping contract state: ${e.message}`));
    process.exit(1);
  }
  await sleep(POST_TX_SLEEP_MS);
}
