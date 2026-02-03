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
import { KeyPair, KeyPairString } from "@near-js/crypto";
import { Account } from "@near-js/accounts";
import { KeyPairSigner } from "@near-js/signers";
import { JsonRpcProvider } from "@near-js/providers";
import { NEAR } from "@near-js/tokens";

export default async function testDifferentAccountId(
  agent: ShadeClient
): Promise<{
  success: boolean;
  agentAccountId: string;
  registrationError?: string;
  callError?: string;
}> {
  const agentAccountId = agent.accountId();

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

  const differentSigner = new KeyPairSigner(differentKeyPair);
  const differentAccount = new Account(differentAccountId, provider, differentSigner);

  const funderPrivateKey = process.env.SPONSOR_PRIVATE_KEY;
  const sponsorAccountId = process.env.SPONSOR_ACCOUNT_ID;
  const funderSigner = KeyPairSigner.fromSecretKey(funderPrivateKey as KeyPairString);
  const funderAccount = new Account(sponsorAccountId as string, provider, funderSigner);

  // Fund the different account
  await funderAccount.transfer({
    token: NEAR,
    amount: NEAR.toUnits(0.3),
    receiverId: differentAccountId,
  });

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
        path: "test-path",
        payload: "b1bce08af8ed85b255f9fa2fe98b8feafa1460959d886e3914d533eca11cb6c6",
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
