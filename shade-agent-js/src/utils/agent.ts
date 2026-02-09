import { createHash } from "node:crypto";
import { DstackClient } from "@phala/dstack-sdk";
import { generateSeedPhrase } from "near-seed-phrase";
import { PublicKey, KeyPairString } from "@near-js/crypto";
import { KeyPairSigner } from "@near-js/signers";
import { addKeysToAccount, removeKeysFromAccount } from "./near";
import { Account } from "@near-js/accounts";
import { Provider } from "@near-js/providers";
import { toThrowable } from "./sanitize";

// Generates an agent account ID and private key
export async function generateAgent(
  dstackClient: DstackClient | undefined,
  derivationPath: string | undefined,
): Promise<{
  accountId: string;
  agentPrivateKey: string;
  derivedWithTEE: boolean;
}> {
  try {
    const { hash, usedTEE } = await deriveHash(dstackClient, derivationPath);
    const seedInfo = generateSeedPhrase(hash);

    const accountId = Buffer.from(PublicKey.from(seedInfo.publicKey).data)
      .toString("hex")
      .toLowerCase();

    return {
      accountId,
      agentPrivateKey: seedInfo.secretKey,
      derivedWithTEE: usedTEE,
    };
  } catch {
    // Throw generic error to avoid leaking hash
    throw new Error("Failed to create agent");
  }
}

// Derives a hash from a derivation path (for deterministic key generation)
function deriveHashFromPath(derivationPath: string): Buffer {
  return createHash("sha256").update(Buffer.from(derivationPath)).digest();
}

// Derives a hash from random data (for non-TEE, non-deterministic generation)
function deriveHashFromRandom(): Buffer {
  const randomArray = new Uint8Array(32);
  crypto.getRandomValues(randomArray);
  const randomString = Buffer.from(randomArray).toString("hex");
  return createHash("sha256").update(Buffer.from(randomString)).digest();
}

// Derives a hash using TEE hardware entropy
async function deriveHashForTEE(dstackClient: DstackClient): Promise<Buffer> {
  // JS crypto random
  const randomArray = new Uint8Array(32);
  crypto.getRandomValues(randomArray);
  const randomString = Buffer.from(randomArray).toString("hex");

  const keyFromTee = (await dstackClient.getKey(randomString)).key;

  // Hash of JS crypto random and TEE entropy
  return Buffer.from(
    await crypto.subtle.digest(
      "SHA-256",
      Buffer.concat([randomArray, keyFromTee]),
    ),
  );
}

// Derives a hash based on the environment (TEE, derivation path, or random)
async function deriveHash(
  dstackClient: DstackClient | undefined,
  derivationPath: string | undefined,
): Promise<{ hash: Buffer; usedTEE: boolean }> {
  let hash: Buffer;
  let usedTEE: boolean;

  if (!dstackClient && derivationPath) {
    // If not in a TEE and a derivation path is provided, use it to generate the hash
    // if different users use the same derivation path, they will get the same account ID
    // so they should generate it to be unique
    hash = deriveHashFromPath(derivationPath);
    usedTEE = false;
  } else if (!dstackClient && !derivationPath) {
    // If it is not in a TEE and no derivation path is provided, generate a random hash
    hash = deriveHashFromRandom();
    usedTEE = false;
  } else {
    // If it is in a TEE generate a hash from the entropy from the TEE hardware and a random string
    hash = await deriveHashForTEE(dstackClient);
    usedTEE = true;
  }

  return { hash, usedTEE };
}

// Manages the setup of additional keys for the agent account
// Derives keys, adds missing ones, and removes excess keys as needed
export async function manageKeySetup(
  agentAccount: Account,
  numAdditionalKeys: number, // Number of additional keys to derive (not total)
  dstackClient: DstackClient | undefined,
  derivationPath: string | undefined,
): Promise<{ keysToSave: string[]; allDerivedWithTEE: boolean }> {
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
    const { keys, allDerivedWithTEE } = await deriveAdditionalKeys(
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
      keysToSave: keysToSave,
      allDerivedWithTEE,
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
): Promise<{ keys: string[]; allDerivedWithTEE: boolean }> {
  // Generate numKeys additional keys
  // Run all derivations in parallel for better performance for TEE
  const keyPromises = Array.from({ length: numKeys }, async (_, index) => {
    const i = index + 1; // Start from 1
    // For additional keys with derivation path, append key index
    const keyDerivationPath = derivationPath
      ? `${derivationPath}-${i}`
      : undefined;
    const { hash, usedTEE } = await deriveHash(dstackClient, keyDerivationPath);
    const seedInfo = generateSeedPhrase(hash);
    // Return both the key and whether it was derived with TEE
    return {
      key: seedInfo.secretKey,
      derivedWithTEE: usedTEE,
    };
  });

  const results = await Promise.all(keyPromises);
  const keys = results.map((r) => r.key);
  // Check if all keys were derived with TEE
  const allDerivedWithTEE = results.every((r) => r.derivedWithTEE);

  return { keys, allDerivedWithTEE };
}

// Gets the next signer from the agent's private keys (rotates through keys)
export function getAgentSigner(
  agentPrivateKeys: string[],
  currentKeyIndex: number,
): { signer: KeyPairSigner; keyIndex: number } {
  try {
    if (agentPrivateKeys.length === 0) {
      throw new Error("No agent keys available");
    }
    if (agentPrivateKeys.length === 1) {
      return {
        signer: KeyPairSigner.fromSecretKey(
          agentPrivateKeys[0] as KeyPairString,
        ),
        keyIndex: 0,
      };
    }
    currentKeyIndex++;
    if (currentKeyIndex > agentPrivateKeys.length - 1) {
      currentKeyIndex = 0;
    }
    return {
      signer: KeyPairSigner.fromSecretKey(
        agentPrivateKeys[currentKeyIndex] as KeyPairString,
      ),
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
  keysDerivedWithTEE: boolean,
  keysChecked: boolean,
): Promise<{ keysToAdd: string[]; wasChecked: boolean }> {
  try {
    if (keysChecked) {
      return { keysToAdd: [], wasChecked: true };
    }

    const signer = KeyPairSigner.fromSecretKey(
      agentPrivateKeys[0] as KeyPairString,
    );
    const agentAccount = new Account(agentAccountId, rpc, signer);
    const { keysToSave, allDerivedWithTEE } = await manageKeySetup(
      agentAccount,
      numKeys - 1,
      dstackClient,
      derivationPath,
    );

    if (!allDerivedWithTEE) {
      if (keysDerivedWithTEE) {
        throw new Error(
          "First key was derived with TEE but additional keys were not. Something went wrong with the key derivation.",
        );
      }
    }

    return { keysToAdd: keysToSave, wasChecked: true };
  } catch (error) {
    throw toThrowable(error);
  }
}
