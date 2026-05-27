import { createHash } from "node:crypto";
import { DstackClient } from "@phala/dstack-sdk";
import { generateSeedPhrase } from "near-seed-phrase";
import { PublicKey } from "@near-js/crypto";
import type { KeyPairSigner } from "@near-js/signers";
import { addKeysToAccount, removeKeysFromAccount } from "./near";
import { Account } from "@near-js/accounts";
import { Provider } from "@near-js/providers";
import { genericError, safeParseSigner, toThrowable } from "./errors";

// Generates an agent account ID and private key
export async function generateAgent(
  dstackClient: DstackClient | undefined,
  derivationPath: string | undefined,
): Promise<{
  accountId: string;
  agentPrivateKey: string;
  derivedWithRandom: boolean;
}> {
  try {
    const { hash, usedRandom } = deriveHash(dstackClient, derivationPath);
    const seedInfo = generateSeedPhrase(hash);

    const accountId = Buffer.from(PublicKey.from(seedInfo.publicKey).data)
      .toString("hex")
      .toLowerCase();

    return {
      accountId,
      agentPrivateKey: seedInfo.secretKey,
      derivedWithRandom: usedRandom,
    };
  } catch (error) {
    throw toThrowable(error);
  }
}

// Derives a hash from a derivation path (for deterministic key generation in local mode)
function deriveHashFromPath(derivationPath: string): Buffer {
  return createHash("sha256").update(Buffer.from(derivationPath)).digest();
}

// 32 bytes of CSPRNG entropy
function deriveHashFromRandom(): Buffer {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
}

// In a TEE the derivationPath is ignored — only random-derived keys are
// permitted to produce a real attestation (see internalGetAttestation).
function deriveHash(
  dstackClient: DstackClient | undefined,
  derivationPath: string | undefined,
): { hash: Buffer; usedRandom: boolean } {
  if (!dstackClient && derivationPath) {
    return { hash: deriveHashFromPath(derivationPath), usedRandom: false };
  }
  return { hash: deriveHashFromRandom(), usedRandom: true };
}

// Manages the setup of additional keys for the agent account.
// Derives keys, adds missing ones, and removes excess keys as needed.
export async function manageKeySetup(
  agentAccount: Account,
  numAdditionalKeys: number, // Number of additional keys to derive (not total)
  dstackClient: DstackClient | undefined,
  derivationPath: string | undefined,
): Promise<{ keysToSave: string[]; allDerivedWithRandom: boolean }> {
  try {
    // Get the number of keys on the account already
    const keysOnAccount = await agentAccount.getAccessKeyList();
    const numKeysOnAccount = keysOnAccount.keys.length;
    const numExistingAdditionalKeys = numKeysOnAccount - 1; // Subtract the first key

    // Derive keys using the higher number (needed for both adding and removing cases)
    const numKeysToDerive = Math.max(
      numAdditionalKeys,
      numExistingAdditionalKeys,
    );
    const { keys, allDerivedWithRandom } = await deriveAdditionalKeys(
      numKeysToDerive,
      dstackClient,
      derivationPath,
    );

    if (numExistingAdditionalKeys < numAdditionalKeys) {
      // Need to add keys
      const keysToAdd = keys.slice(
        numExistingAdditionalKeys,
        numAdditionalKeys,
      );
      await addKeysToAccount(agentAccount, keysToAdd);
    } else if (numExistingAdditionalKeys > numAdditionalKeys) {
      // Need to remove excess keys
      const excessKeys = keys.slice(numAdditionalKeys);
      await removeKeysFromAccount(agentAccount, excessKeys);
    }

    // Return only the desired number of keys
    const keysToSave = keys.slice(0, numAdditionalKeys);

    return {
      keysToSave,
      allDerivedWithRandom,
    };
  } catch (error) {
    throw toThrowable(error);
  }
}

// Derives additional keys for the agent account
async function deriveAdditionalKeys(
  numKeys: number,
  dstackClient: DstackClient | undefined,
  derivationPath: string | undefined,
): Promise<{ keys: string[]; allDerivedWithRandom: boolean }> {
  try {
    // Generate numKeys additional keys
    const keyPromises = Array.from({ length: numKeys }, async (_, index) => {
      const i = index + 1; // Start from 1
      // For additional keys with derivation path, append key index
      const keyDerivationPath = derivationPath
        ? `${derivationPath}-${i}`
        : undefined;
      const { hash, usedRandom } = deriveHash(dstackClient, keyDerivationPath);
      const seedInfo = generateSeedPhrase(hash);
      return {
        key: seedInfo.secretKey,
        usedRandom,
      };
    });

    const results = await Promise.all(keyPromises);
    return {
      keys: results.map((r) => r.key),
      allDerivedWithRandom: results.every((r) => r.usedRandom),
    };
  } catch (error) {
    throw toThrowable(error);
  }
}

// Gets the next signer from the agent's private keys (rotates through keys)
export function getAgentSigner(
  agentPrivateKeys: string[],
  currentKeyIndex: number,
): { signer: KeyPairSigner; keyIndex: number } {
  try {
    if (agentPrivateKeys.length === 0) {
      throw genericError("No agent keys available");
    }
    if (agentPrivateKeys.length === 1) {
      return {
        signer: safeParseSigner(agentPrivateKeys[0]),
        keyIndex: 0,
      };
    }
    currentKeyIndex++;
    if (currentKeyIndex > agentPrivateKeys.length - 1) {
      currentKeyIndex = 0;
    }
    return {
      signer: safeParseSigner(agentPrivateKeys[currentKeyIndex]),
      keyIndex: currentKeyIndex,
    };
  } catch (error) {
    throw toThrowable(error);
  }
}

// Ensures keys are set up correctly on the account, adding or removing keys as needed
export async function ensureKeysSetup(
  agentAccountId: string,
  agentPrivateKeys: string[],
  rpc: Provider,
  numKeys: number,
  dstackClient: DstackClient | undefined,
  derivationPath: string | undefined,
  keysDerivedWithRandom: boolean,
  keysChecked: boolean,
): Promise<{ keysToAdd: string[]; wasChecked: boolean }> {
  try {
    if (keysChecked) {
      return { keysToAdd: [], wasChecked: true };
    }

    const signer = safeParseSigner(agentPrivateKeys[0]);
    const agentAccount = new Account(agentAccountId, rpc, signer);
    const { keysToSave, allDerivedWithRandom } = await manageKeySetup(
      agentAccount,
      numKeys - 1,
      dstackClient,
      derivationPath,
    );

    if (allDerivedWithRandom !== keysDerivedWithRandom) {
      throw genericError(
        "First key and additional keys disagree on derivation method. Something went wrong with the key derivation.",
      );
    }

    return { keysToAdd: keysToSave, wasChecked: true };
  } catch (error) {
    throw toThrowable(error);
  }
}
