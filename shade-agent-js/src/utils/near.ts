import { JsonRpcProvider } from "@near-js/providers";
import { Provider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { Account } from "@near-js/accounts";
import { KeyPair, KeyPairString } from "@near-js/crypto";
import { NEAR } from "@near-js/tokens";
import { actionCreators } from "@near-js/transactions";
import { toThrowable } from "./errors";

// Creates a default JSON RPC provider for the specified network.
// The provider itself retries 3× with 2 s backoff at the transport layer —
// no per-call retry loops needed in this module.
export function createDefaultProvider(networkId: string): JsonRpcProvider {
  try {
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
  } catch (error) {
    throw toThrowable(error);
  }
}

// Creates an Account instance.
export function createAccountObject(
  accountId: string,
  provider: Provider,
  signer?: KeyPairSigner,
): Account {
  try {
    return new Account(accountId, provider, signer);
  } catch (error) {
    throw toThrowable(error);
  }
}

// Transfers NEAR tokens from sponsor account to agent account.
// `account.transfer(...)` already throws on `status.Failure` (it uses
// `signAndSendTransaction({ throwOnFailure: true })` internally), so no
// manual outcome inspection or retry loop is needed.
export async function internalFundAgent(
  agentAccountId: string,
  sponsorAccountId: string,
  sponsorPrivateKey: string,
  amount: number,
  provider: Provider,
): Promise<void> {
  try {
    const signer = KeyPairSigner.fromSecretKey(
      sponsorPrivateKey as KeyPairString,
    );
    const account = new Account(sponsorAccountId, provider, signer);
    await account.transfer({
      token: NEAR,
      amount: NEAR.toUnits(amount),
      receiverId: agentAccountId,
    });
  } catch (error) {
    throw toThrowable(error);
  }
}

// Adds multiple keys to the agent account in one transaction.
// Uses `account.signAndSendTransaction` which throws on `status.Failure`.
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
    await account.signAndSendTransaction({
      receiverId: account.accountId,
      actions,
    });
  } catch (error) {
    throw toThrowable(error);
  }
}

// Removes multiple keys from the agent account in one transaction.
export async function removeKeysFromAccount(
  account: Account,
  secrets: string[],
): Promise<void> {
  try {
    const actions = secrets.map((secretKey) => {
      const keyPair = KeyPair.fromString(secretKey as KeyPairString);
      return actionCreators.deleteKey(keyPair.getPublicKey());
    });
    await account.signAndSendTransaction({
      receiverId: account.accountId,
      actions,
    });
  } catch (error) {
    throw toThrowable(error);
  }
}
