/**
 * Test 5: Can't submit attestation from different account ID
 * 
 * In script: Correct PPID
 * In TEE: Check that it can register and make a call
 * In script: Check that it is indeed registered
 * In TEE: Call get attestation, generate new random keypair and account id
 *   without shade-agent-js then using NAJ submit the attestation,
 *   check it fails because report data don't match,
 *   check can't make a call from this account
 * In script: Check not another registered agent
 */

import { ShadeClient } from "@neardefi/shade-agent-js";
import { KeyPair } from "@near-js/crypto";
import { Account } from "@near-js/accounts";
import { KeyPairSigner } from "@near-js/signers";
import { JsonRpcProvider } from "@near-js/providers";
import { internalGetAttestation, getDstackClient } from "@neardefi/shade-agent-js/src/utils/tee";
import { attestationForContract } from "@neardefi/shade-agent-js/src/utils/attestation-transform";

export default async function testDifferentAccountId(
  agent: ShadeClient
): Promise<{
  success: boolean;
  agentAccountId: string;
  registrationSuccess?: boolean;
  callSuccess?: boolean;
  differentAccountError?: string;
}> {
  const agentAccountId = agent.accountId();

  // Check that it can register and make a call
  let registrationSuccess = false;
  try {
    registrationSuccess = await agent.register();
  } catch (error: any) {
    return {
      success: false,
      agentAccountId,
      registrationSuccess: false,
      differentAccountError: `Registration failed: ${error.message}`,
    };
  }

  // Try to make a call
  let callSuccess = false;
  try {
    await agent.call({
      methodName: "request_signature",
      args: {
        path: "test",
        payload: "test",
        key_type: "Ecdsa",
      },
    });
    callSuccess = true;
  } catch (error: any) {
    return {
      success: false,
      agentAccountId,
      registrationSuccess,
      callSuccess: false,
      differentAccountError: `Call failed: ${error.message}`,
    };
  }

  // Now try to submit attestation from a different account
  // Generate a new random keypair and account ID
  const differentKeyPair = KeyPair.fromRandom("ed25519");
  const publicKey = differentKeyPair.getPublicKey();
  const differentAccountIdBytes = publicKey.data;
  const differentAccountId = Buffer.from(differentAccountIdBytes).toString("hex").toLowerCase();

  // Get attestation for the original agent account (this will have wrong report data)
  const dstackClient = await getDstackClient();
  const attestation = await internalGetAttestation(
    dstackClient || undefined,
    agentAccountId, // Use original account ID - this creates wrong report data
    true
  );

  // Try to register with different account using the attestation
  // This should fail because report data doesn't match
  const agentContractId = process.env.AGENT_CONTRACT_ID;
  if (!agentContractId) {
    return {
      success: false,
      agentAccountId,
      registrationSuccess,
      callSuccess,
      differentAccountError: "AGENT_CONTRACT_ID not set",
    };
  }

  const provider = new JsonRpcProvider({
    url: "https://rpc.testnet.near.org",
  });

  const secretKey = differentKeyPair.toString();
  const signer = KeyPairSigner.fromSecretKey(secretKey);
  const differentAccount = new Account(differentAccountId, provider, signer);

  let differentAccountError: string | undefined;
  try {
    const contractAttestation = attestationForContract(attestation);
    await differentAccount.callFunction({
      contractId: agentContractId,
      methodName: "register_agent",
      args: {
        attestation: contractAttestation,
      },
      gas: BigInt("300000000000000"), // 300 TGas
    });
    differentAccountError = "Registration with different account should have failed but succeeded";
  } catch (error: any) {
    differentAccountError = error.message || String(error);
    // Expected to fail
  }

  // Try to make a call from the different account - should fail
  try {
    await differentAccount.callFunction({
      contractId: agentContractId,
      methodName: "request_signature",
      args: {
        path: "test",
        payload: "test",
        key_type: "Ecdsa",
      },
    });
    if (!differentAccountError) {
      differentAccountError = "Call from different account should have failed but succeeded";
    }
  } catch (error: any) {
    // Expected to fail - this is good
  }

  const success =
    registrationSuccess &&
    callSuccess &&
    differentAccountError !== undefined &&
    differentAccountError !== "Registration with different account should have failed but succeeded" &&
    differentAccountError !== "Call from different account should have failed but succeeded";

  return {
    success,
    agentAccountId,
    registrationSuccess,
    callSuccess,
    differentAccountError,
  };
}
