/**
 * Test 6: Can't do stuff if measurements are removed
 *
 * In script: Remove measurements
 * In TEE: Try to make call, return raw result (no error checking)
 * In script: Check callError contains InvalidMeasurements, verify agent removed from map
 */

import { ShadeClient } from "@neardefi/shade-agent-js";

export default async function testMeasurementsRemoved(
  agent: ShadeClient,
): Promise<{
  agentAccountId: string;
  callError?: string;
}> {
  const agentAccountId = agent.accountId();

  // Agent should already be registered (registration happens in the register-agent endpoint)
  // Try to make a call - script will check error and agent removal
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
    callError,
  };
}
