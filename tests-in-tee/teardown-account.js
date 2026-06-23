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
export async function deleteContractAccount(account, accountId, beneficiaryId) {
  if (!accountId) return;
  console.log(`\nTearing down contract account ${accountId}...`);
  const clearSentinel = () =>
    fs.rmSync(resolve(__dirname, ".contract-id"), { force: true });
  try {
    await account.deleteAccount(beneficiaryId);
    console.log(`✓ Contract account ${accountId} torn down`);
    clearSentinel();
  } catch (e) {
    const msg = e?.message ?? String(e);
    if (/(does ?n[o']t exist|AccountDoesNotExist|UnknownAccount|AccessKeyDoesNotExist)/i.test(msg)) {
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
  const provider = new JsonRpcProvider({ url: "https://test.rpc.fastnear.com" });
  const signer = KeyPairSigner.fromSecretKey(privateKey);
  const account = new Account(accountId, provider, signer);
  await deleteContractAccount(account, accountId, beneficiaryId);
}
