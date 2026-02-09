/**
 * Test 1: Successful registration and signature request
 *
 * In script: Approve correct measurements and PPIDs
 * In TEE: Register agent, request signature - return raw result (no error checking)
 * In script: Check no errors, verify agent is registered externally
 */

import { ShadeClient } from "@neardefi/shade-agent-js";

export default async function testSuccessfulRegistration(
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
  } catch (error: any) {
    registrationError = error.message || String(error);
  }

  let callError: string | undefined;
  if (!registrationError) {
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
    } catch (error: any) {
      callError = error.message || String(error);
    }
  }

  return {
    agentAccountId,
    registrationError,
    callError,
  };
}
