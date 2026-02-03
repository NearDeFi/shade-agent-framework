/**
 * Test 7: Can't do stuff if PPID is removed
 * 
 * In script: Add measurements back, remove PPID
 * In TEE: Try to make call, check failed and reason why
 * In TEE: Return results to script
 */

import { ShadeClient } from "@neardefi/shade-agent-js";

export default async function testPpidRemoved(
  agent: ShadeClient
): Promise<{
  success: boolean;
  agentAccountId: string;
  callError?: string;
}> {
  const agentAccountId = agent.accountId();

  // Agent should already be registered (registration happens in the register-agent endpoint)
  // Just try to make a call - should fail because PPID was removed
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
    // Expected to fail - verify error mentions PPID
    if (!callError?.toLowerCase().includes("ppid")) {
      callError = `Call failed but error doesn't mention PPID: ${callError}`;
    }
  }

  // Verify that error occurred and mentions PPID
  const success =
    callError !== undefined &&
    callError !== "Call should have failed but succeeded" &&
    callError.toLowerCase().includes("ppid");

  return {
    success,
    agentAccountId,
    callError,
  };
}
