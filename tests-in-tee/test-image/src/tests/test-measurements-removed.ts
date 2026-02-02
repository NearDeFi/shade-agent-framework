/**
 * Test 6: Can't do stuff if measurements are removed
 * 
 * In script: Remove measurements
 * In TEE: Try to make call, check failed and reason why
 * In TEE: Return results to script
 */

import { ShadeClient } from "@neardefi/shade-agent-js";

export default async function testMeasurementsRemoved(
  agent: ShadeClient
): Promise<{
  success: boolean;
  agentAccountId: string;
  callError?: string;
}> {
  const agentAccountId = agent.accountId();

  // Try to make a call - should fail because measurements were removed
  let callError: string | undefined;
  try {
    await agent.call({
      methodName: "request_signature",
      args: {
        path: "test",
        payload: "test",
        key_type: "Ecdsa",
      },
    });
    callError = "Call should have failed but succeeded";
  } catch (error: any) {
    callError = error.message || String(error);
    // Expected to fail - verify error mentions measurements
    if (!callError.toLowerCase().includes("measurement")) {
      callError = `Call failed but error doesn't mention measurements: ${callError}`;
    }
  }

  // Verify that error occurred and mentions measurements
  const success =
    callError !== undefined &&
    callError !== "Call should have failed but succeeded" &&
    callError.toLowerCase().includes("measurement");

  return {
    success,
    agentAccountId,
    callError,
  };
}
