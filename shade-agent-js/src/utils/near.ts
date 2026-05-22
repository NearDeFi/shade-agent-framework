import { JsonRpcProvider } from "@near-js/providers";
import { Provider } from "@near-js/providers";
import type { KeyPairSigner } from "@near-js/signers";
import { Account } from "@near-js/accounts";
import { NEAR } from "@near-js/tokens";
import { actionCreators } from "@near-js/transactions";
import { safeParseKeyPair, safeParseSigner, toThrowable } from "./errors";

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
export async function internalFundAgent(
  agentAccountId: string,
  sponsorAccountId: string,
  sponsorPrivateKey: string,
  amount: number,
  provider: Provider,
): Promise<void> {
  try {
    const signer = safeParseSigner(sponsorPrivateKey);
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
export async function addKeysToAccount(
  account: Account,
  secrets: string[],
): Promise<void> {
  try {
    const actions = secrets.map((secretKey) => {
      const keyPair = safeParseKeyPair(secretKey);
      return actionCreators.addKey(
        keyPair.getPublicKey(),
        actionCreators.fullAccessKey(),
      );
    });
    await account.signAndSendTransaction({
      receiverId: account.accountId,
      actions,
      throwOnFailure: true,
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
      const keyPair = safeParseKeyPair(secretKey);
      return actionCreators.deleteKey(keyPair.getPublicKey());
    });
    await account.signAndSendTransaction({
      receiverId: account.accountId,
      actions,
      throwOnFailure: true,
    });
  } catch (error) {
    throw toThrowable(error);
  }
}
