/**
 * Test 4: Can't verify with wrong PPID
 * 
 * In script: Add correct measurements, add wrong PPID
 * In TEE: Try to register, check it fails
 * In TEE: Try to make a call, check it fails and the reason why
 * In TEE: Return results to script
 * Check in script: That not registered
 */

import { ShadeClient } from "@neardefi/shade-agent-js";

export default async function testWrongPpid(
  agent: ShadeClient
): Promise<{
  success: boolean;
  agentAccountId: string;
  registrationError?: string;
  callError?: string;
}> {
  const agentAccountId = agent.accountId();

  // Try to register - should fail
  let registrationError: string | undefined;
  try {
    await agent.register();
    registrationError = "Registration should have failed but succeeded";
  } catch (error: any) {
    registrationError = error.message || String(error);
    // Expected to fail
  }

  // Try to make a call - should fail
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
    callError = "Call should have failed but succeeded";
  } catch (error: any) {
    callError = error.message || String(error);
    // Expected to fail
  }

  // Verify that errors occurred (as expected)
  const success =
    registrationError !== undefined &&
    callError !== undefined &&
    registrationError !== "Registration should have failed but succeeded" &&
    callError !== "Call should have failed but succeeded";

  return {
    success,
    agentAccountId,
    registrationError,
    callError,
  };
}
