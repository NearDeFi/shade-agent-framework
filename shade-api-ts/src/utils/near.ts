import { JsonRpcProvider } from "@near-js/providers";
import { Provider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { Account } from "@near-js/accounts";
import { KeyPair, KeyPairString } from "@near-js/crypto";
import { NEAR } from "@near-js/tokens";
import { FinalExecutionOutcome } from "@near-js/types";
import { actionCreators } from "@near-js/transactions";

export function createDefaultProvider(networkId: string): JsonRpcProvider {
    return new JsonRpcProvider(
        {
            url:
                networkId === 'testnet'
                    ? 'https://test.rpc.fastnear.com'
                    : 'https://free.rpc.fastnear.com',
        },
        {
            retries: 3,
            backoff: 2,
            wait: 1000,
        },
    );
}

export async function fundAgent(agentAccountId: string, sponsorAccountId: string, sponsorPrivateKey: string, amount: number, provider: Provider): Promise<void> {
    const signer = KeyPairSigner.fromSecretKey(sponsorPrivateKey as KeyPairString);

    const account = new Account(sponsorAccountId, provider, signer);

    const maxRetries = 3;
    let lastError: Error | undefined;
    let fundResult: FinalExecutionOutcome | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            fundResult = await account.transfer(
                {
                    token: NEAR,
                    amount: NEAR.toUnits(amount),
                    receiverId: agentAccountId
                }
            );

            // Check transaction status
            if (typeof fundResult.status === 'object' && fundResult.status.Failure) {
                const errorMsg = fundResult.status.Failure.error_message || fundResult.status.Failure.error_type;
                lastError = new Error(`Transfer transaction failed: ${errorMsg}`);
                // Continue to retry if not the last attempt
                if (attempt < maxRetries) {
                    continue;
                }
            } else {
                // Success - transaction completed without failure
                return;
            }
        } catch (error) {
            lastError = new Error(`Failed to fund agent account ${agentAccountId} (attempt ${attempt}/${maxRetries}): ${error}`);
            // Continue to retry if not the last attempt
            if (attempt < maxRetries) {
                continue;
            }
        }
    }

    // All retries exhausted, throw the last error
    throw lastError || new Error(`Failed to fund agent account ${agentAccountId} after ${maxRetries} attempts`);
}

/**
 * Adds multiple keys to the agent account from secret keys
 * @param account - The agent Account instance
 * @param secrets - Array of secret keys to add to the account
 * @returns void
 */
export async function addKeysFromSecrets(account: Account, secrets: string[]): Promise<void> {
    const maxRetries = 3;
    let lastError: Error | undefined;
    let txResult: FinalExecutionOutcome | undefined;

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
            txResult = await account.provider.sendTransaction(tx);

            // Check transaction status
            if (typeof txResult.status === 'object' && txResult.status.Failure) {
                const errorMsg = txResult.status.Failure.error_message || txResult.status.Failure.error_type;
                lastError = new Error(`Add keys transaction failed: ${errorMsg}`);
                // Continue to retry if not the last attempt
                if (attempt < maxRetries) {
                    continue;
                }
            } else {
                // Success - transaction completed without failure
                return;
            }
        } catch (error) {
            lastError = new Error(`Failed to add keys (attempt ${attempt}/${maxRetries}): ${error instanceof Error ? error.message : String(error)}`);
            // Continue to retry if not the last attempt
            if (attempt < maxRetries) {
                continue;
            }
        }
    }

    // All retries exhausted, throw the last error
    throw lastError || new Error(`Failed to add keys after ${maxRetries} attempts`);
}