import { JsonRpcProvider } from "@near-js/providers";
import { Provider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { Account } from "@near-js/accounts";
import { KeyPair, KeyPairString } from "@near-js/crypto";
import { NEAR } from "@near-js/tokens";
import { actionCreators } from "@near-js/transactions";
import { sanitize } from "./sanitize";

// Creates a default JSON RPC provider for the specified network
export function createDefaultProvider(networkId: string): JsonRpcProvider {
  return new JsonRpcProvider(
    {
      url:
        networkId === "testnet"
          ? "https://test.rpc.fastnear.com"
          : "https://free.rpc.fastnear.com",
    },
    {
      retries: 3,
      backoff: 2,
      wait: 1000,
    },
  );
}

// Creates an Account instance
export function createAccountObject(
  accountId: string,
  provider: Provider,
  signer?: KeyPairSigner,
): Account {
  try {
    return new Account(accountId, provider, signer);
  } catch (error) {
    // return generic error to avoid leaking sensitive data
    throw new Error(`Failed to create account object`);
  }
}

// Transfers NEAR tokens from sponsor account to agent account
export async function internalFundAgent(
  agentAccountId: string,
  sponsorAccountId: string,
  sponsorPrivateKey: string,
  amount: number,
  provider: Provider,
): Promise<void> {
  const signer = KeyPairSigner.fromSecretKey(
    sponsorPrivateKey as KeyPairString,
  );

  const account = new Account(sponsorAccountId, provider, signer);

  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const fundResult = await account.transfer({
        token: NEAR,
        amount: NEAR.toUnits(amount),
        receiverId: agentAccountId,
      });

      // Check transaction status
      if (typeof fundResult.status === "object" && fundResult.status.Failure) {
        const rawMsg =
          fundResult.status.Failure.error_message ||
          fundResult.status.Failure.error_type;
        const sanitized = sanitize(String(rawMsg));
        const errorMsg =
          typeof sanitized === "string" ? sanitized : String(sanitized);
        const error = new Error(`Transfer transaction failed: ${errorMsg}`);
        // Throw on final attempt, otherwise retry
        if (attempt === maxRetries) {
          throw error;
        }
        continue;
      } else {
        // Success - transaction completed without failure
        return;
      }
    } catch {
      // Throw on final attempt, otherwise retry - do not propagate error message to avoid leaking sensitive data
      if (attempt === maxRetries) {
        throw new Error(
          `Failed to fund agent account ${agentAccountId} after ${maxRetries} attempts`,
        );
      }
    }
  }
}

// Adds multiple keys to the agent account from secret keys
export async function addKeysToAccount(
  account: Account,
  secrets: string[],
): Promise<void> {
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Build actions for adding keys
      const actions = secrets.map((secretKey) => {
        const keyPair = KeyPair.fromString(secretKey as KeyPairString);
        return actionCreators.addKey(
          keyPair.getPublicKey(),
          actionCreators.fullAccessKey(),
        );
      });

      // Create signed transaction
      const tx = await account.createSignedTransaction(
        account.accountId,
        actions,
      );

      // Send transaction
      const txResult = await account.provider.sendTransaction(tx);

      // Check transaction status
      if (typeof txResult.status === "object" && txResult.status.Failure) {
        // Throw on final attempt, otherwise retry - generic message only
        if (attempt === maxRetries) {
          throw new Error(`Failed to add keys after ${maxRetries} attempts`);
        }
        continue;
      } else {
        // Success - transaction completed without failure
        return;
      }
    } catch {
      // Throw on final attempt, otherwise retry - do not propagate error message to avoid leaking sensitive data
      if (attempt === maxRetries) {
        throw new Error(`Failed to add keys after ${maxRetries} attempts`);
      }
    }
  }
}

// Removes multiple keys from the agent account
export async function removeKeysFromAccount(
  account: Account,
  secrets: string[],
): Promise<void> {
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Build actions for removing keys
      const actions = secrets.map((secretKey) => {
        const keyPair = KeyPair.fromString(secretKey as KeyPairString);
        return actionCreators.deleteKey(keyPair.getPublicKey());
      });

      // Create signed transaction
      const tx = await account.createSignedTransaction(
        account.accountId,
        actions,
      );

      // Send transaction
      const txResult = await account.provider.sendTransaction(tx);

      // Check transaction status
      if (typeof txResult.status === "object" && txResult.status.Failure) {
        // Throw on final attempt, otherwise retry - generic message only
        if (attempt === maxRetries) {
          throw new Error(`Failed to remove keys after ${maxRetries} attempts`);
        }
        continue;
      } else {
        // Success - transaction completed without failure
        return;
      }
    } catch {
      // Throw on final attempt, otherwise retry - do not propagate error message to avoid leaking sensitive data
      if (attempt === maxRetries) {
        throw new Error(`Failed to remove keys after ${maxRetries} attempts`);
      }
    }
  }
}
