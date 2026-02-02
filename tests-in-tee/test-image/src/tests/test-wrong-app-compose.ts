/**
 * Test 3: Can't verify with wrong app compose
 * 
 * In script: Add correct measurements except app compose, keep everything the same
 *   except for an env variable (same docker image)
 * In TEE: Try to register, check it fails
 * In TEE: Try to make a call, check it fails and the reason why
 * In TEE: Return results to script
 * Check in script: That not registered
 * In script: Remove old measurements and PPID
 */

import { ShadeClient } from "@neardefi/shade-agent-js";

export default async function testWrongAppCompose(
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
        path: "test",
        payload: "test",
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
