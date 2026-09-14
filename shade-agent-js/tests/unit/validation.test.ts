import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateShadeConfig } from "../../src/utils/validation";
import type { ShadeConfig } from "../../src/api";
import { createMockProvider } from "../mocks";
import { createDefaultProvider } from "../../src/utils/near";

vi.mock("../../src/utils/near", () => ({
  createDefaultProvider: vi.fn(),
}));

describe("validateShadeConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the mock to return a provider that matches the networkId
    vi.mocked(createDefaultProvider).mockImplementation(
      (networkId: string) => createMockProvider(networkId) as any,
    );
  });

  it("should set default networkId to testnet when not provided", async () => {
    const config: ShadeConfig = {};
    await validateShadeConfig(config);
    expect(config.networkId).toBe("testnet");
  });

  it("should accept testnet as networkId", async () => {
    const config: ShadeConfig = { networkId: "testnet" };
    await validateShadeConfig(config);
    expect(config.networkId).toBe("testnet");
  });

  it("should accept mainnet as networkId", async () => {
    const config: ShadeConfig = { networkId: "mainnet" };
    await validateShadeConfig(config);
    expect(config.networkId).toBe("mainnet");
  });

  it("should throw error when networkId does not match RPC provider network", async () => {
    const config: ShadeConfig = { networkId: "testnet" };

    // Mock provider to return a different network ID
    vi.mocked(createDefaultProvider).mockReturnValue(
      createMockProvider("mainnet") as any,
    );

    await expect(validateShadeConfig(config)).rejects.toThrow(
      'Network ID mismatch: config.networkId is "testnet" but RPC provider is connected to "mainnet"',
    );
  });

  it("should throw error for invalid networkId", async () => {
    const config: ShadeConfig = { networkId: "invalid" as any };
    await expect(validateShadeConfig(config)).rejects.toThrow(
      "networkId must be either 'testnet' or 'mainnet'",
    );
  });

  it("should set default numKeys to 1 when not provided", async () => {
    const config: ShadeConfig = { networkId: "testnet" };
    await validateShadeConfig(config);
    expect(config.numKeys).toBe(1);
  });

  it("should accept valid numKeys between 1 and 100", async () => {
    const config: ShadeConfig = { networkId: "testnet", numKeys: 5 };
    await validateShadeConfig(config);
    expect(config.numKeys).toBe(5);
  });

  it("should throw error for numKeys less than 1", async () => {
    const config: ShadeConfig = { networkId: "testnet", numKeys: 0 };
    await expect(validateShadeConfig(config)).rejects.toThrow(
      "numKeys must be an integer between 1 and 100",
    );
  });

  it("should throw error for numKeys greater than 100", async () => {
    const config: ShadeConfig = { networkId: "testnet", numKeys: 101 };
    await expect(validateShadeConfig(config)).rejects.toThrow(
      "numKeys must be an integer between 1 and 100",
    );
  });

  it("should throw error for non-integer numKeys", async () => {
    const config: ShadeConfig = { networkId: "testnet", numKeys: 5.5 as any };
    await expect(validateShadeConfig(config)).rejects.toThrow(
      "numKeys must be an integer between 1 and 100",
    );
  });

  it("should validate sponsor accountId when sponsor is provided", async () => {
    const config: ShadeConfig = {
      networkId: "testnet",
      sponsor: {
        accountId: "",
        privateKey: "ed25519:test",
      },
    };
    await expect(validateShadeConfig(config)).rejects.toThrow(
      "sponsor.accountId is required when sponsor is provided",
    );
  });

  it("should validate sponsor privateKey when sponsor is provided", async () => {
    const config: ShadeConfig = {
      networkId: "testnet",
      sponsor: {
        accountId: "sponsor.testnet",
        privateKey: "",
      },
    };
    await expect(validateShadeConfig(config)).rejects.toThrow(
      "sponsor.privateKey is required when sponsor is provided",
    );
  });

  it("should accept valid sponsor configuration", async () => {
    const config: ShadeConfig = {
      networkId: "testnet",
      sponsor: {
        accountId: "sponsor.testnet",
        privateKey: "ed25519:test",
      },
    };
    await validateShadeConfig(config);
    expect(config.sponsor?.accountId).toBe("sponsor.testnet");
  });

  it("should use provided RPC provider without creating default", async () => {
    const mockProvider = createMockProvider("testnet");
    const config: ShadeConfig = {
      networkId: "testnet",
      rpc: mockProvider,
    };

    await validateShadeConfig(config);

    // Verify createDefaultProvider was NOT called
    expect(createDefaultProvider).not.toHaveBeenCalled();
    expect(config.rpc).toBeDefined();
  });

  describe("pccsEndpoints", () => {
    it("should default to the Phala → Intel fallback ladder when not provided", async () => {
      const config: ShadeConfig = { networkId: "testnet" };
      await validateShadeConfig(config);
      expect(config.pccsEndpoints).toEqual([
        "https://pccs.phala.network",
        "https://api.trustedservices.intel.com",
      ]);
    });

    it("should accept a custom list of http(s) URLs", async () => {
      const config: ShadeConfig = {
        networkId: "testnet",
        pccsEndpoints: [
          "https://pccs.local.example",
          "http://10.0.0.1:8081",
        ],
      };
      await validateShadeConfig(config);
      expect(config.pccsEndpoints).toEqual([
        "https://pccs.local.example",
        "http://10.0.0.1:8081",
      ]);
    });

    it("should reject an empty array (mirrors mpc's NonEmptyVec invariant)", async () => {
      const config: ShadeConfig = {
        networkId: "testnet",
        pccsEndpoints: [],
      };
      await expect(validateShadeConfig(config)).rejects.toThrow(
        "pccsEndpoints must be a non-empty array",
      );
    });

    it("should reject a non-array value", async () => {
      const config: ShadeConfig = {
        networkId: "testnet",
        pccsEndpoints: "https://pccs.phala.network" as any,
      };
      await expect(validateShadeConfig(config)).rejects.toThrow(
        "pccsEndpoints must be an array of URL strings",
      );
    });

    it("should reject non-string entries", async () => {
      const config: ShadeConfig = {
        networkId: "testnet",
        pccsEndpoints: [123 as any],
      };
      await expect(validateShadeConfig(config)).rejects.toThrow(
        "pccsEndpoints entries must be non-empty strings",
      );
    });

    it("should reject malformed URL entries", async () => {
      const config: ShadeConfig = {
        networkId: "testnet",
        pccsEndpoints: ["not-a-url"],
      };
      await expect(validateShadeConfig(config)).rejects.toThrow(
        "pccsEndpoints entries must be valid URLs",
      );
    });

    it("should reject non-http(s) protocols", async () => {
      const config: ShadeConfig = {
        networkId: "testnet",
        pccsEndpoints: ["ftp://pccs.example.com"],
      };
      await expect(validateShadeConfig(config)).rejects.toThrow(
        "pccsEndpoints entries must use http or https protocol",
      );
    });

    it.each([
      ["javascript:alert(1)", "pccsEndpoints entries must use http or https protocol"],
      ["file:///etc/passwd", "pccsEndpoints entries must use http or https protocol"],
      ["https://user:secret@pccs.example.com", "must not contain credentials, query or fragment"],
      ["https://pccs.example.com/?x=1", "must not contain credentials, query or fragment"],
      ["https://pccs.example.com/#frag", "must not contain credentials, query or fragment"],
      ["https://pccs.example.com/?", "must not contain credentials, query or fragment"],
      ["https://pccs.example.com/#", "must not contain credentials, query or fragment"],
    ])("should reject %s", async (entry, message) => {
      const config: ShadeConfig = {
        networkId: "testnet",
        pccsEndpoints: ["https://pccs.phala.network", entry],
      };
      await expect(validateShadeConfig(config)).rejects.toThrow(message);
    });

    it("should reject an empty string among otherwise valid entries", async () => {
      const config: ShadeConfig = {
        networkId: "testnet",
        pccsEndpoints: ["https://pccs.phala.network", ""],
      };
      await expect(validateShadeConfig(config)).rejects.toThrow(
        "pccsEndpoints entries must be non-empty strings",
      );
    });

    it("should trim surrounding whitespace from entries", async () => {
      const config: ShadeConfig = {
        networkId: "testnet",
        pccsEndpoints: ["  https://pccs.example.com \n"],
      };
      await validateShadeConfig(config);
      expect(config.pccsEndpoints).toEqual(["https://pccs.example.com"]);
    });

    it("should accept URLs with a port, an IPv6 host, or a certification path suffix", async () => {
      const config: ShadeConfig = {
        networkId: "testnet",
        pccsEndpoints: [
          "https://[::1]:8081",
          "https://pccs.example.com:8081/sgx/certification/v4/",
        ],
      };
      await validateShadeConfig(config);
      expect(config.pccsEndpoints).toHaveLength(2);
    });
  });
});
