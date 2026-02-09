/**
 * Test 2: Can't verify with wrong measurements (RTMR2)
 *
 * In script: Approve correct PPID, key provider, app compose, all but RTMR2
 * In TEE: Try to register, try to make call - return raw result (no error checking)
 * In script: Check registrationError, callError, verify not registered
 */

import { ShadeClient } from "@neardefi/shade-agent-js";

export default async function testWrongMeasurementsRtmr2(
  agent: ShadeClient,
): Promise<{
  agentAccountId: string;
  registrationError?: string;
  callError?: string;
}> {
  const agentAccountId = agent.accountId();

  let registrationError: string | undefined;
  try {
    await agent.register();
    registrationError = "Registration should have failed but succeeded";
  } catch (error: any) {
    registrationError = error.message || String(error);
  }

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
    callError = error.message || String(error);
  }

  return {
    agentAccountId,
    registrationError,
    callError,
  };
}
