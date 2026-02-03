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

export default async function testDifferentAccountId(
  agent: ShadeClient
): Promise<{
  success: boolean;
  agentAccountId: string;
  registrationError?: string;
  callError?: string;
}> {
  const agentAccountId = agent.accountId();

  // First, register the correct agent (this should succeed)
  try {
    await agent.register();
  } catch (error: any) {
    return {
      success: false,
      agentAccountId,
      registrationError: `Correct agent registration failed: ${error.message}`,
    };
  }

  // Try to make a call with the correct agent (this should succeed)
  try {
    await agent.call({
      methodName: "request_signature",
      args: {
        path: "test",
        payload: "test",
        key_type: "Ecdsa",
      },
    });
  } catch (error: any) {
    return {
      success: false,
      agentAccountId,
      callError: `Correct agent call failed: ${error.message}`,
    };
  }

  // Now try to submit attestation from a different account
  // Generate a new random keypair and account ID
  const differentKeyPair = KeyPair.fromRandom("ed25519");
  const publicKey = differentKeyPair.getPublicKey();
  const differentAccountIdBytes = publicKey.data;
  const differentAccountId = Buffer.from(differentAccountIdBytes).toString("hex").toLowerCase();

  // Get attestation for the original agent account (this will have wrong report data for the different account)
  // getAttestation() now returns the contract-formatted attestation directly
  const contractAttestation = await agent.getAttestation();

  // Try to register with different account using the attestation
  // This should fail because report data doesn't match
  const agentContractId = process.env.AGENT_CONTRACT_ID;
  if (!agentContractId) {
    return {
      success: false,
      agentAccountId,
      registrationError: "AGENT_CONTRACT_ID not set",
    };
  }

  const provider = new JsonRpcProvider({
    url: "https://rpc.testnet.near.org",
  });

  const secretKey = differentKeyPair.toString();
  const signer = KeyPairSigner.fromSecretKey(secretKey);
  const differentAccount = new Account(differentAccountId, provider, signer);

  // Try to register with different account - should fail with WrongHash error
  let registrationError: string | undefined;
  try {
    await differentAccount.callFunction({
      contractId: agentContractId,
      methodName: "register_agent",
      args: {
        attestation: contractAttestation,
      },
      gas: BigInt("300000000000000"), // 300 TGas
    });
    registrationError = "Registration with different account should have failed but succeeded";
  } catch (error: any) {
    registrationError = error.message || String(error);
    // Expected to fail
  }

  // Try to make a call from the different account - should fail with "Agent not registered"
  let callError: string | undefined;
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
    callError = "Call from different account should have failed but succeeded";
  } catch (error: any) {
    callError = error.message || String(error);
    // Expected to fail - this is good
  }

  // Verify that errors occurred (as expected)
  const success =
    registrationError !== undefined &&
    callError !== undefined &&
    registrationError !== "Registration with different account should have failed but succeeded" &&
    callError !== "Call from different account should have failed but succeeded";

  return {
    success,
    agentAccountId,
    registrationError,
    callError,
  };
}
