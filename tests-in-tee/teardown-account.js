#!/usr/bin/env node

/**
 * Delete a per-run test contract account, refunding its remaining balance to
 * the parent (TESTNET_ACCOUNT_ID). Used by test-script.js's teardown `finally`
 * and, as a CLI, by the CI backstop step that runs if the runner was killed
 * before that `finally` could run:
 *
 *   node teardown-account.js <accountId>
 */

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import fs from "fs";
import { Account } from "@near-js/accounts";
import { KeyPairSigner } from "@near-js/signers";
import { JsonRpcProvider } from "@near-js/providers";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Delete `accountId`, sending its remaining balance to `beneficiaryId`.
// Idempotent (an already-gone account counts as success) and never throws —
// teardown runs in a finally and must never mask the real failure. Removes the
// persisted .contract-id on success so a backstop won't try again.
export async function deleteContractAccount(account, beneficiaryId) {
  const accountId = account?.accountId;
  if (!accountId) return;
  console.log(`\nTearing down contract account ${accountId}...`);
  // Swallows its own error so deleteContractAccount keeps its no-throw contract.
  const clearSentinel = () => {
    try {
      fs.rmSync(resolve(__dirname, ".contract-id"), { force: true });
    } catch (e) {
      console.error(`⚠ Could not remove .contract-id: ${e.message}`);
    }
  };
  try {
    await account.deleteAccount(beneficiaryId);
    console.log(`✓ Contract account ${accountId} torn down`);
    clearSentinel();
  } catch (e) {
    // Only a genuinely-missing account counts as already-gone 
    const msg = e?.message ?? String(e);
    const gone =
      e?.type === "AccountDoesNotExist" ||
      /AccountDoesNotExist|does ?n[o']t exist|UnknownAccount/i.test(msg);
    if (gone) {
      console.log(`✓ Contract account ${accountId} already gone`);
      clearSentinel();
    } else {
      console.error(`⚠ Failed to tear down contract account ${accountId}: ${msg}`);
    }
  }
}

// CLI entry (CI backstop): build an Account from env + arg and delete it.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const accountId = process.argv[2];
  const beneficiaryId = process.env.TESTNET_ACCOUNT_ID;
  const privateKey = process.env.TESTNET_PRIVATE_KEY;
  if (!accountId) {
    console.error("Usage: node teardown-account.js <accountId>");
    process.exit(1);
  }
  if (!beneficiaryId || !privateKey) {
    console.error("Missing TESTNET_ACCOUNT_ID / TESTNET_PRIVATE_KEY");
    process.exit(1);
  }
  // The backstop runs with a privileged key on an id read from the workspace
  // .contract-id file, so only ever delete a per-run test subaccount of
  // TESTNET_ACCOUNT_ID — never the parent or an unrelated account.
  if (!accountId.startsWith("shade-test-") || !accountId.endsWith(`.${beneficiaryId}`)) {
    console.error(
      `Refusing to delete "${accountId}": expected a shade-test-<slug>.${beneficiaryId} subaccount.`,
    );
    process.exit(1);
  }
  const provider = new JsonRpcProvider(
    { url: "https://test.rpc.fastnear.com" },
    { retries: 3, backoff: 2, wait: 1000 },
  );
  const signer = KeyPairSigner.fromSecretKey(privateKey);
  const account = new Account(accountId, provider, signer);
  await deleteContractAccount(account, beneficiaryId);
}
