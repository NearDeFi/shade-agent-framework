/**
 * Test 10: Can't do stuff if attestation has expired
 *
 * In script: Set expiration to 10s, approve measurements and PPIDs
 * In TEE: Register agent, wait 12 seconds (so attestation expires), then request_signature, return raw result
 * In script: Check callError contains ExpiredAttestation, verify agent removed from map
 */

import { ShadeClient } from "@neardefi/shade-agent-js";

const EXPIRATION_WAIT_MS = 12_000;

export default async function testAttestationExpired(
  agent: ShadeClient,
): Promise<{
  agentAccountId: string;
  registrationError?: string;
  callError?: string;
}> {
  const agentAccountId = agent.accountId();

  // Register agent (contract has 10s expiration set by script)
  let registrationError: string | undefined;
  try {
    await agent.register();
  } catch (error: any) {
    registrationError = error?.message ?? String(error);
    return { agentAccountId, registrationError };
  }

  // Wait 12 seconds for attestation to expire
  await new Promise((resolve) => setTimeout(resolve, EXPIRATION_WAIT_MS));

  // Try request_signature - script will check error and agent removal
  let callError: string | undefined;
  try {
    await agent.call({
      methodName: "request_signature",
      args: {
        path: "test-path",
        payload:
          "b1bce08af8ed85b255f9fa2fe98b8feafa1460959d886e3914d533eca11cb6c6",
        key_type: "Ecdsa",
      },
    });
    callError = "Call should have failed but succeeded";
  } catch (error: any) {
    callError = error?.message ?? String(error);
  }

  return {
    agentAccountId,
    registrationError,
    callError,
  };
}
