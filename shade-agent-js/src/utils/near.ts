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

  try {
    const fundResult = await account.transfer({
      token: NEAR,
      amount: NEAR.toUnits(amount),
      receiverId: agentAccountId,
    });

    if (typeof fundResult.status === "object" && fundResult.status.Failure) {
      const rawMsg =
        fundResult.status.Failure.error_message ||
        fundResult.status.Failure.error_type;
      const sanitized = sanitize(String(rawMsg));
      const errorMsg =
        typeof sanitized === "string" ? sanitized : String(sanitized);
      throw new Error(`Transfer transaction failed: ${errorMsg}`);
    }
  } catch {
    // Generic error to avoid leaking sensitive data
    throw new Error(`Failed to fund agent account ${agentAccountId}`);
  }
}

// Adds multiple keys to the agent account from secret keys
export async function addKeysToAccount(
  account: Account,
  secrets: string[],
): Promise<void> {
  try {
    const actions = secrets.map((secretKey) => {
      const keyPair = KeyPair.fromString(secretKey as KeyPairString);
      return actionCreators.addKey(
        keyPair.getPublicKey(),
        actionCreators.fullAccessKey(),
      );
    });

    const tx = await account.createSignedTransaction(
      account.accountId,
      actions,
    );

    const txResult = await account.provider.sendTransaction(tx);

    if (typeof txResult.status === "object" && txResult.status.Failure) {
      throw new Error(`Failed to add keys`);
    }
  } catch {
    // Generic error to avoid leaking sensitive data
    throw new Error(`Failed to add keys`);
  }
}

// Removes multiple keys from the agent account
export async function removeKeysFromAccount(
  account: Account,
  secrets: string[],
): Promise<void> {
  try {
    const actions = secrets.map((secretKey) => {
      const keyPair = KeyPair.fromString(secretKey as KeyPairString);
      return actionCreators.deleteKey(keyPair.getPublicKey());
    });

    const tx = await account.createSignedTransaction(
      account.accountId,
      actions,
    );

    const txResult = await account.provider.sendTransaction(tx);

    if (typeof txResult.status === "object" && txResult.status.Failure) {
      throw new Error(`Failed to remove keys`);
    }
  } catch {
    // Generic error to avoid leaking sensitive data
    throw new Error(`Failed to remove keys`);
  }
}
