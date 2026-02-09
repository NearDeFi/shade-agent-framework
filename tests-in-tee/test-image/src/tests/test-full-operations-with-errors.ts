/**
 * Test: Full operations with intentional errors + private key leak detection
 *
 * Runs every ShadeClient operation: create, fund, register, view, balance,
 * getAttestation, isWhitelisted, call, getPrivateKeys. Also:
 * - Attempts to fund with 1M NEAR (expects error - insufficient balance)
 * - Calls nonexistent_method_xyz (expects error - function doesn't exist)
 *
 * Wraps execution to detect private key leaks in console output and response.
 * Private keys are NEVER included in the response.
 */

import { ShadeClient } from "@neardefi/shade-agent-js";

// Patterns that indicate a private key leak (NEAR ed25519/secp256k1 format)
const PRIVATE_KEY_PATTERNS = [
  /ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/,
  /secp256k1:[1-9A-HJ-NP-Za-km-z]{40,}/,
];

function containsPrivateKey(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  return PRIVATE_KEY_PATTERNS.some((re) => re.test(text));
}

function scanForPrivateKeyLeak(obj: unknown): boolean {
  if (obj === null || obj === undefined) return false;
  const str = typeof obj === "string" ? obj : JSON.stringify(obj);
  return containsPrivateKey(str);
}

export default async function testFullOperationsWithErrors(): Promise<{
  success: boolean;
  agentAccountId?: string;
  operations: {
    create: { ok: boolean; error?: string };
    fundNormal: { ok: boolean; error?: string };
    register: { ok: boolean; error?: string };
    viewContractInfo: { ok: boolean; error?: string };
    balance: { ok: boolean; error?: string };
    getAttestation: { ok: boolean; error?: string };
    isWhitelisted: { ok: boolean; error?: string };
    fund1Million: { ok: boolean; error?: string };
    callNonexistent: { ok: boolean; error?: string };
    getPrivateKeysCalled: { ok: boolean; error?: string };
  };
  leakedInConsole: boolean;
  leakedInResponse: boolean;
  error?: string;
}> {
  const consoleCapture: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  const capture = (method: typeof console.log, args: unknown[]) => {
    const msg = args
      .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
      .join(" ");
    consoleCapture.push(msg);
    method.apply(console, args);
  };

  console.log = (...args: unknown[]) => capture(originalLog, args);
  console.warn = (...args: unknown[]) => capture(originalWarn, args);
  console.error = (...args: unknown[]) => capture(originalError, args);

  const result: {
    success: boolean;
    agentAccountId?: string;
    operations: {
      create: { ok: boolean; error?: string };
      fundNormal: { ok: boolean; error?: string };
      register: { ok: boolean; error?: string };
      viewContractInfo: { ok: boolean; error?: string };
      balance: { ok: boolean; error?: string };
      getAttestation: { ok: boolean; error?: string };
      isWhitelisted: { ok: boolean; error?: string };
      fund1Million: { ok: boolean; error?: string };
      callNonexistent: { ok: boolean; error?: string };
      getPrivateKeysCalled: { ok: boolean; error?: string };
    };
    leakedInConsole: boolean;
    leakedInResponse: boolean;
    error?: string;
  } = {
    success: false,
    operations: {
      create: { ok: false },
      fundNormal: { ok: false },
      register: { ok: false },
      viewContractInfo: { ok: false },
      balance: { ok: false },
      getAttestation: { ok: false },
      isWhitelisted: { ok: false },
      fund1Million: { ok: false },
      callNonexistent: { ok: false },
      getPrivateKeysCalled: { ok: false },
    },
    leakedInConsole: false,
    leakedInResponse: false,
  };

  try {
    // 1. Create agent
    let agent: ShadeClient;
    try {
      agent = await ShadeClient.create({
        networkId: "testnet",
        agentContractId: process.env.AGENT_CONTRACT_ID,
        sponsor: {
          accountId: process.env.SPONSOR_ACCOUNT_ID!,
          privateKey: process.env.SPONSOR_PRIVATE_KEY!,
        },
        derivationPath: process.env.SPONSOR_PRIVATE_KEY,
      });
      result.operations.create = { ok: true };
      result.agentAccountId = agent.accountId();
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      result.operations.create = { ok: false, error: err };
      throw e;
    }

    // 2. Fund with normal amount (0.3 NEAR)
    try {
      await agent.fund(0.3);
      result.operations.fundNormal = { ok: true };
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      result.operations.fundNormal = { ok: false, error: err };
    }

    // 3. Register
    try {
      await agent.register();
      result.operations.register = { ok: true };
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      result.operations.register = { ok: false, error: err };
    }

    // 4. View: get_contract_info
    try {
      await agent.view({ methodName: "get_contract_info", args: {} });
      result.operations.viewContractInfo = { ok: true };
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      result.operations.viewContractInfo = { ok: false, error: err };
    }

    // 5. Balance
    try {
      await agent.balance();
      result.operations.balance = { ok: true };
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      result.operations.balance = { ok: false, error: err };
    }

    // 6. Get attestation
    try {
      await agent.getAttestation();
      result.operations.getAttestation = { ok: true };
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      result.operations.getAttestation = { ok: false, error: err };
    }

    // 7. isWhitelisted (returns null when requires_tee)
    try {
      await agent.isWhitelisted();
      result.operations.isWhitelisted = { ok: true };
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      result.operations.isWhitelisted = { ok: false, error: err };
    }

    // 8. Fund with 1 million NEAR - expect error (insufficient balance)
    try {
      await agent.fund(1_000_000);
      result.operations.fund1Million = {
        ok: true,
        error: "Expected to fail but succeeded",
      };
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      result.operations.fund1Million = { ok: false, error: err };
    }

    // 9. Call nonexistent function - expect error
    try {
      await agent.call({
        methodName: "nonexistent_method_xyz",
        args: {},
      });
      result.operations.callNonexistent = {
        ok: true,
        error: "Expected to fail but succeeded",
      };
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      result.operations.callNonexistent = { ok: false, error: err };
    }

    // 10. getPrivateKeys - exercise the path; we NEVER include keys in response
    try {
      agent.getPrivateKeys(true);
      result.operations.getPrivateKeysCalled = { ok: true };
    } catch (e: unknown) {
      const err = e instanceof Error ? e.message : String(e);
      result.operations.getPrivateKeysCalled = { ok: false, error: err };
    }

    // Restore console
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;

    // Check for private key leaks in console capture
    result.leakedInConsole = consoleCapture.some((line) =>
      containsPrivateKey(line),
    );

    // Scan response for leaks (belt and suspenders - we never include keys)
    result.leakedInResponse = scanForPrivateKeyLeak(result);

    result.success =
      result.operations.create.ok &&
      result.operations.fundNormal.ok &&
      result.operations.register.ok &&
      result.operations.viewContractInfo.ok &&
      result.operations.balance.ok &&
      result.operations.getAttestation.ok &&
      result.operations.isWhitelisted.ok &&
      !result.operations.fund1Million.ok &&
      !result.operations.callNonexistent.ok &&
      result.operations.getPrivateKeysCalled.ok &&
      !result.leakedInConsole &&
      !result.leakedInResponse;

    return result;
  } catch (e: unknown) {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    result.error = e instanceof Error ? e.message : String(e);
    result.leakedInConsole = consoleCapture.some((line) =>
      containsPrivateKey(line),
    );
    result.leakedInResponse = scanForPrivateKeyLeak(result);
    return result;
  }
}
