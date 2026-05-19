/**
 * Per-call-site routing check.
 *
 * Verifies that every wrapped function in shade-agent-js routes its caught
 * error through `toThrowable`. The sanitiser's behaviour on every leak shape
 * is exhaustively tested in `errors.test.ts`; here we only check the wiring.
 *
 * If this file fails, a wrapped function is either missing its try/catch
 * or its catch bypasses `toThrowable` (e.g. rethrows the raw error). Fix the
 * call site, not this test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as errorsModule from "../../src/utils/errors";
import {
  internalFundAgent,
  addKeysToAccount,
  removeKeysFromAccount,
  createAccountObject,
} from "../../src/utils/near";
import { generateAgent } from "../../src/utils/agent";
import { internalGetAttestation } from "../../src/utils/tee";
import {
  transformQuote,
  transformCollateral,
  transformTcbInfo,
  attestationForContract,
} from "../../src/utils/attestation-transform";
import { createMockAccount, createMockProvider } from "../mocks";
import { createMockDstackClient } from "../mocks/tee-mocks";
import { generateTestKey } from "../test-utils";

// Wrap toThrowable in a spy that still calls through to the real impl, and
// bypass withRetry so an inner toThrowable invocation doesn't pollute the
// outer-catch assertion.
vi.mock("../../src/utils/errors", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("../../src/utils/errors");
  return {
    ...actual,
    toThrowable: vi.fn(actual.toThrowable),
    withRetry: <T,>(fn: () => Promise<T>) => fn(),
  };
});

vi.mock("@near-js/accounts", async () => {
  const actual = await vi.importActual<typeof import("@near-js/accounts")>(
    "@near-js/accounts",
  );
  return {
    ...actual,
    Account: vi.fn(function (this: any, accountId: string) {
      this.accountId = accountId;
      this.transfer = vi.fn();
    }),
  };
});

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  vi.mocked(errorsModule.toThrowable).mockClear();
});

async function expectThrows(fn: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await fn();
    throw new Error("expected throw");
  } catch {
    /* swallow — we just want to ensure the function rejected */
  }
}

describe("redaction: each wrapped function routes errors through toThrowable", () => {
  describe("near.ts", () => {
    it("internalFundAgent", async () => {
      const account = createMockAccount();
      (account.transfer as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("network fail"),
      );
      const { Account } = await import("@near-js/accounts");
      vi.mocked(Account).mockImplementationOnce(function (this: any) {
        Object.assign(this, account);
        return this;
      });
      await expectThrows(() =>
        internalFundAgent(
          "agent.testnet",
          "sponsor.testnet",
          generateTestKey("k"),
          1,
          createMockProvider(),
        ),
      );
      expect(errorsModule.toThrowable).toHaveBeenCalled();
    });

    it("addKeysToAccount", async () => {
      const account = createMockAccount();
      (
        account.signAndSendTransaction as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error("network fail"));
      await expectThrows(() =>
        addKeysToAccount(account, [generateTestKey("k")]),
      );
      expect(errorsModule.toThrowable).toHaveBeenCalled();
    });

    it("removeKeysFromAccount", async () => {
      const account = createMockAccount();
      (
        account.signAndSendTransaction as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error("network fail"));
      await expectThrows(() =>
        removeKeysFromAccount(account, [generateTestKey("k")]),
      );
      expect(errorsModule.toThrowable).toHaveBeenCalled();
    });

    it("createAccountObject", async () => {
      const { Account } = await import("@near-js/accounts");
      vi.mocked(Account).mockImplementationOnce(() => {
        throw new Error("ctor fail");
      });
      await expectThrows(() =>
        createAccountObject("agent.testnet", createMockProvider()),
      );
      expect(errorsModule.toThrowable).toHaveBeenCalled();
    });
  });

  describe("agent.ts", () => {
    it("generateAgent (TEE path)", async () => {
      const client = createMockDstackClient();
      (client.getKey as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("TEE fail"),
      );
      await expectThrows(() => generateAgent(client, undefined));
      expect(errorsModule.toThrowable).toHaveBeenCalled();
    });
  });

  describe("tee.ts", () => {
    it("internalGetAttestation — dstackClient.info throws", async () => {
      const client = createMockDstackClient();
      (client.info as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("info fail"),
      );
      await expectThrows(() =>
        internalGetAttestation(client, "agent.testnet", true),
      );
      expect(errorsModule.toThrowable).toHaveBeenCalled();
    });

    it("internalGetAttestation — dstackClient.getQuote throws", async () => {
      const client = createMockDstackClient();
      (client.getQuote as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("quote fail"),
      );
      await expectThrows(() =>
        internalGetAttestation(client, "agent.testnet", true),
      );
      expect(errorsModule.toThrowable).toHaveBeenCalled();
    });

    it("internalGetAttestation — fetch throws", async () => {
      const client = createMockDstackClient();
      mockFetch.mockRejectedValue(new Error("fetch fail"));
      await expectThrows(() =>
        internalGetAttestation(client, "agent.testnet", true),
      );
      expect(errorsModule.toThrowable).toHaveBeenCalled();
    });
  });

  describe("attestation-transform.ts", () => {
    it("transformQuote", async () => {
      const spy = vi.spyOn(Buffer, "from").mockImplementationOnce(() => {
        throw new Error("buffer fail");
      });
      await expectThrows(() => transformQuote("0xdeadbeef"));
      expect(errorsModule.toThrowable).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("transformCollateral", async () => {
      const spy = vi.spyOn(Buffer, "from").mockImplementation(() => {
        throw new Error("buffer fail");
      });
      await expectThrows(() =>
        transformCollateral({ root_ca_crl: "deadbeef" }),
      );
      expect(errorsModule.toThrowable).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("transformTcbInfo", async () => {
      const bad = {
        mrtd: "x",
        rtmr0: "x",
        rtmr1: "x",
        rtmr2: "x",
        rtmr3: "x",
        os_image_hash: "x",
        compose_hash: "x",
        device_id: "x",
        app_compose: "x",
        event_log: new Proxy([] as unknown[], {
          get(target, prop) {
            if (prop === "map") {
              return () => {
                throw new Error("map fail");
              };
            }
            return (target as any)[prop];
          },
        }) as any,
      };
      await expectThrows(() => transformTcbInfo(bad as any));
      expect(errorsModule.toThrowable).toHaveBeenCalled();
    });

    it("attestationForContract", async () => {
      const bad = {
        quote: [],
        collateral: new Proxy({} as any, {
          get(_target, prop) {
            if (prop === "pck_crl_issuer_chain") return "";
            throw new Error("collateral fail");
          },
        }),
        tcb_info: {} as any,
      };
      await expectThrows(() => attestationForContract(bad as any));
      expect(errorsModule.toThrowable).toHaveBeenCalled();
    });
  });
});
