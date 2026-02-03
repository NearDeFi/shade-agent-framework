/**
 * Test 7: Successful registration and signature request
 * 
 * In script: Approve correct measurements and PPIDs
 * In TEE: Register agent (should succeed)
 * In TEE: Request signature (should succeed)
 * In script: Verify agent is registered externally
 */

import { ShadeClient } from "@neardefi/shade-agent-js";

export default async function testSuccessfulRegistration(
  agent: ShadeClient
): Promise<{
  success: boolean;
  agentAccountId: string;
  registrationError?: string;
  callError?: string;
}> {
  const agentAccountId = agent.accountId();

  // Try to register - should succeed
  let registrationError: string | undefined;
  try {
    await agent.register();
  } catch (error: any) {
    registrationError = error.message || String(error);
    return {
      success: false,
      agentAccountId,
      registrationError,
    };
  }

  // Try to make a call - should succeed
  // Use a proper hex payload (64 hex characters = 32 bytes)
  let callError: string | undefined;
  try {
    await agent.call({
      methodName: "request_signature",
      args: {
        path: "test-path",
        payload: "b1bce08af8ed85b255f9fa2fe98b8feafa1460959d886e3914d533eca11cb6c6",
        key_type: "Ecdsa",
      },
    });
  } catch (error: any) {
    callError = error.message || String(error);
    return {
      success: false,
      agentAccountId,
      callError,
    };
  }

  // Both operations succeeded
  return {
    success: true,
    agentAccountId,
  };
}
