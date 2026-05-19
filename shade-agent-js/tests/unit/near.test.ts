import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createDefaultProvider,
  createAccountObject,
  internalFundAgent,
  addKeysToAccount,
  removeKeysFromAccount,
} from "../../src/utils/near";
import {
  createMockProvider,
  createMockAccount,
  createMockSigner,
} from "../mocks";
import { Account } from "@near-js/accounts";
import { JsonRpcProvider } from "@near-js/providers";
import { NEAR } from "@near-js/tokens";
import { generateTestKey } from "../test-utils";

vi.mock("@near-js/providers", () => ({
  JsonRpcProvider: vi.fn(),
}));

// Store Account method mocks globally so they can be overridden per test
const accountMockOverrides = {
  transfer: null as any,
};

vi.mock("@near-js/accounts", () => {
  const MockAccount = vi.fn(function (
    this: any,
    accountId: string,
    provider: any,
    signer?: any,
  ) {
    const mockAccount = createMockAccount();
    this.accountId = accountId;
    this.provider = provider;
    this.signer = signer;
    this.transfer = accountMockOverrides.transfer || mockAccount.transfer;
    return this;
  });
  return { Account: MockAccount };
});

describe("near utils", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountMockOverrides.transfer = null;
  });

  describe("createDefaultProvider", () => {
    it("should create provider for testnet", () => {
      const provider = createDefaultProvider("testnet");
      expect(JsonRpcProvider).toHaveBeenCalledWith(
        { url: "https://test.rpc.fastnear.com" },
        { retries: 3, backoff: 2, wait: 1000 },
      );
      expect(provider).toBeDefined();
    });

    it("should create provider for mainnet", () => {
      const provider = createDefaultProvider("mainnet");
      expect(JsonRpcProvider).toHaveBeenCalledWith(
        { url: "https://free.rpc.fastnear.com" },
        { retries: 3, backoff: 2, wait: 1000 },
      );
      expect(provider).toBeDefined();
    });
  });

  describe("createAccountObject", () => {
    it("should create Account without signer", () => {
      const mockProvider = createMockProvider();
      const account = createAccountObject("test.testnet", mockProvider);
      expect(account).toBeDefined();
      expect(account.accountId).toBe("test.testnet");
    });

    it("should create Account with signer", () => {
      const mockProvider = createMockProvider();
      const mockSigner = createMockSigner();
      const account = createAccountObject(
        "test.testnet",
        mockProvider,
        mockSigner,
      );
      expect(account).toBeDefined();
      expect(account.accountId).toBe("test.testnet");
    });

    it("should rethrow sanitised error when Account constructor fails", () => {
      vi.mocked(Account).mockImplementationOnce(function () {
        throw new Error("Invalid account");
      });
      expect(() =>
        createAccountObject("test.testnet", createMockProvider()),
      ).toThrow("Invalid account");
    });
  });

  describe("internalFundAgent", () => {
    function setupFundAgent(transferImpl: any) {
      const mockProvider = createMockProvider();
      const mockTransfer =
        typeof transferImpl === "function"
          ? transferImpl
          : vi.fn().mockResolvedValue(transferImpl);
      accountMockOverrides.transfer = mockTransfer;
      return { mockProvider, mockTransfer };
    }

    it("transfers NEAR on success", async () => {
      const { mockProvider, mockTransfer } = setupFundAgent({
        status: { SuccessValue: "" },
      });
      await internalFundAgent(
        "agent.testnet",
        "sponsor.testnet",
        generateTestKey("sponsor-key"),
        1.5,
        mockProvider,
      );
      expect(mockTransfer).toHaveBeenCalledTimes(1);
      expect(mockTransfer).toHaveBeenCalledWith({
        token: NEAR,
        amount: NEAR.toUnits(1.5),
        receiverId: "agent.testnet",
      });
    });

    it("rethrows sanitised when transfer throws (no retry)", async () => {
      const { mockProvider, mockTransfer } = setupFundAgent(
        vi.fn().mockRejectedValue(new Error("Network error")),
      );
      await expect(
        internalFundAgent(
          "agent.testnet",
          "sponsor.testnet",
          generateTestKey("sponsor-key"),
          1.0,
          mockProvider,
        ),
      ).rejects.toThrow("Network error");
      expect(mockTransfer).toHaveBeenCalledTimes(1);
    });

    it("redacts ed25519 secret in error from transfer", async () => {
      const { mockProvider } = setupFundAgent(
        vi
          .fn()
          .mockRejectedValue(
            new Error("Failed with key ed25519:ZZTESTSECRETZZ"),
          ),
      );
      const settled = internalFundAgent(
        "agent.testnet",
        "sponsor.testnet",
        generateTestKey("sponsor-key"),
        1.0,
        mockProvider,
      ).then(
        () => "ok",
        (e) => e as Error,
      );
      const result = await settled;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("[REDACTED]");
      expect((result as Error).message).not.toContain("ZZTESTSECRET");
    });
  });

  describe("addKeysToAccount", () => {
    it("adds keys via single signAndSendTransaction call", async () => {
      const mockAccount = createMockAccount();
      (
        mockAccount.signAndSendTransaction as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ status: { SuccessValue: "" } });

      const key1 = generateTestKey("key1");
      const key2 = generateTestKey("key2");
      await addKeysToAccount(mockAccount, [key1, key2]);

      expect(mockAccount.signAndSendTransaction).toHaveBeenCalledTimes(1);
      expect(mockAccount.signAndSendTransaction).toHaveBeenCalledWith({
        receiverId: mockAccount.accountId,
        actions: expect.arrayContaining([
          expect.any(Object),
          expect.any(Object),
        ]),
        throwOnFailure: true,
      });
    });

    it("rethrows sanitised when signAndSendTransaction throws (no retry)", async () => {
      const mockAccount = createMockAccount();
      (
        mockAccount.signAndSendTransaction as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error("Network error"));
      await expect(
        addKeysToAccount(mockAccount, [generateTestKey("key1")]),
      ).rejects.toThrow("Network error");
      expect(mockAccount.signAndSendTransaction).toHaveBeenCalledTimes(1);
    });

    it("redacts secret leaked in signAndSendTransaction error", async () => {
      const mockAccount = createMockAccount();
      (
        mockAccount.signAndSendTransaction as ReturnType<typeof vi.fn>
      ).mockRejectedValue(
        new Error("Bad signer ed25519:ZZTESTSECRETADDKEYZZ"),
      );
      const settled = addKeysToAccount(mockAccount, [
        generateTestKey("key1"),
      ]).then(
        () => "ok",
        (e) => e as Error,
      );
      const result = await settled;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("[REDACTED]");
      expect((result as Error).message).not.toContain("ZZTESTSECRETADDKEY");
    });
  });

  describe("removeKeysFromAccount", () => {
    it("removes keys via single signAndSendTransaction call", async () => {
      const mockAccount = createMockAccount();
      (
        mockAccount.signAndSendTransaction as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ status: { SuccessValue: "" } });

      const key1 = generateTestKey("key1");
      const key2 = generateTestKey("key2");
      await removeKeysFromAccount(mockAccount, [key1, key2]);

      expect(mockAccount.signAndSendTransaction).toHaveBeenCalledTimes(1);
      expect(mockAccount.signAndSendTransaction).toHaveBeenCalledWith({
        receiverId: mockAccount.accountId,
        actions: expect.arrayContaining([
          expect.any(Object),
          expect.any(Object),
        ]),
        throwOnFailure: true,
      });
    });

    it("rethrows sanitised when signAndSendTransaction throws (no retry)", async () => {
      const mockAccount = createMockAccount();
      (
        mockAccount.signAndSendTransaction as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error("Network error"));
      await expect(
        removeKeysFromAccount(mockAccount, [generateTestKey("key1")]),
      ).rejects.toThrow("Network error");
      expect(mockAccount.signAndSendTransaction).toHaveBeenCalledTimes(1);
    });

    it("redacts secret leaked in signAndSendTransaction error", async () => {
      const mockAccount = createMockAccount();
      (
        mockAccount.signAndSendTransaction as ReturnType<typeof vi.fn>
      ).mockRejectedValue(
        new Error("Bad signer ed25519:ZZTESTSECRETREMKEYZZ"),
      );
      const settled = removeKeysFromAccount(mockAccount, [
        generateTestKey("key1"),
      ]).then(
        () => "ok",
        (e) => e as Error,
      );
      const result = await settled;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("[REDACTED]");
      expect((result as Error).message).not.toContain("ZZTESTSECRETREMKEY");
    });
  });
});
