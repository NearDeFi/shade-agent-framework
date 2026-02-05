import { describe, it, expect, vi, beforeEach } from "vitest";
import { ShadeClient, ShadeConfig } from "../../src/api";
import { createMockAccount, createMockProvider } from "../mocks";
import { createMockDstackClient } from "../mocks/tee-mocks";
import {
  generateTestKey,
  createMockAttestation,
  createMockContractAttestation,
} from "../test-utils";
import { NEAR } from "@near-js/tokens";
import { validateShadeConfig } from "../../src/utils/validation";
import { getDstackClient, internalGetAttestation } from "../../src/utils/tee";
import {
  generateAgent,
  ensureKeysSetup,
  getAgentSigner,
} from "../../src/utils/agent";
import { createAccountObject, internalFundAgent } from "../../src/utils/near";

vi.mock("../../src/utils/validation", () => ({
  validateShadeConfig: vi.fn(),
}));

vi.mock("../../src/utils/tee", () => ({
  getDstackClient: vi.fn(),
  internalGetAttestation: vi.fn(),
}));

vi.mock("../../src/utils/agent", () => ({
  generateAgent: vi.fn(),
  ensureKeysSetup: vi.fn(),
  getAgentSigner: vi.fn(),
}));

vi.mock("../../src/utils/near", () => ({
  createAccountObject: vi.fn(),
  internalFundAgent: vi.fn(),
}));

// Store mock account globally so Account class can access it
let globalMockAccount: any = null;

// Mock Account class - return our mock account instance
vi.mock("@near-js/accounts", () => {
  const MockAccount = vi.fn(function (
    this: any,
    accountId: string,
    provider: any,
    signer?: any,
  ) {
    const mockAccount = globalMockAccount || createMockAccount();
    this.accountId = accountId;
    this.provider = provider;
    this.signer = signer;
    this.getBalance = mockAccount.getBalance;
    this.callFunction = mockAccount.callFunction;
    this.transfer = mockAccount.transfer;
    this.getAccessKeyList = mockAccount.getAccessKeyList;
    return this;
  });
  return { Account: MockAccount };
});

describe("ShadeClient", () => {
  let mockProvider: ReturnType<typeof createMockProvider>;
  let mockAccount: ReturnType<typeof createMockAccount>;
  let mockDstackClient: ReturnType<typeof createMockDstackClient>;
  const testAccountId = "test-agent.testnet";
  const testPrivateKey = generateTestKey("test-seed");

  beforeEach(() => {
    vi.clearAllMocks();
    globalMockAccount = null;

    mockProvider = createMockProvider("testnet");
    mockAccount = createMockAccount();
    globalMockAccount = mockAccount;
    mockDstackClient = createMockDstackClient();
  });

  // Helper function to set up mocks
  function setupClientMocks(options?: {
    dstackClient?: ReturnType<typeof createMockDstackClient>;
    derivedWithTEE?: boolean;
    keysToAdd?: string[];
    wasChecked?: boolean;
  }) {
    vi.mocked(validateShadeConfig).mockResolvedValue(undefined);
    vi.mocked(getDstackClient).mockResolvedValue(
      options?.dstackClient || undefined,
    );
    vi.mocked(generateAgent).mockResolvedValue({
      accountId: testAccountId,
      agentPrivateKey: testPrivateKey,
      derivedWithTEE: options?.derivedWithTEE ?? false,
    });
    vi.mocked(createAccountObject).mockReturnValue(mockAccount);
    vi.mocked(ensureKeysSetup).mockResolvedValue({
      keysToAdd: options?.keysToAdd ?? [],
      wasChecked: options?.wasChecked ?? false,
    });
    vi.mocked(getAgentSigner).mockReturnValue({
      signer: {} as any,
      keyIndex: 0,
    });
    vi.mocked(internalGetAttestation).mockResolvedValue(
      createMockContractAttestation(),
    );
  }

  describe("create", () => {
    it("should create ShadeClient with minimal config", async () => {
      setupClientMocks();
      const config: ShadeConfig = {};

      const client = await ShadeClient.create(config);

      expect(validateShadeConfig).toHaveBeenCalledWith(config);
      expect(getDstackClient).toHaveBeenCalled();
      expect(generateAgent).toHaveBeenCalledWith(undefined, undefined);
      expect(client.accountId()).toBe(testAccountId);
    });

    it("should create ShadeClient with full config", async () => {
      setupClientMocks();
      const config: ShadeConfig = {
        networkId: "mainnet",
        agentContractId: "agent.contract.testnet",
        sponsor: {
          accountId: "sponsor.testnet",
          privateKey: "sponsor-key",
        },
        rpc: mockProvider,
        numKeys: 5,
        derivationPath: "test-path",
      };

      const client = await ShadeClient.create(config);

      expect(validateShadeConfig).toHaveBeenCalledWith(config);
      expect(generateAgent).toHaveBeenCalledWith(undefined, "test-path");
      expect(client.accountId()).toBe(testAccountId);
    });

    it("should create ShadeClient with TEE client", async () => {
      setupClientMocks({
        dstackClient: mockDstackClient,
        derivedWithTEE: true,
      });
      const config: ShadeConfig = {};

      const client = await ShadeClient.create(config);

      expect(getDstackClient).toHaveBeenCalled();
      expect(generateAgent).toHaveBeenCalledWith(mockDstackClient, undefined);
      expect(client.accountId()).toBe(testAccountId);
    });

    it("should throw error if validation fails", async () => {
      vi.mocked(validateShadeConfig).mockRejectedValue(
        new Error("Invalid config"),
      );

      await expect(ShadeClient.create({})).rejects.toThrow("Invalid config");
    });
  });

  describe("accountId", () => {
    it("should return the agent account ID", async () => {
      setupClientMocks();
      const client = await ShadeClient.create({});

      expect(client.accountId()).toBe(testAccountId);
    });
  });

  describe("balance", () => {
    it("should return account balance in NEAR", async () => {
      setupClientMocks();
      const balance = NEAR.toUnits("10");
      (mockAccount.getBalance as ReturnType<typeof vi.fn>).mockResolvedValue(
        balance,
      );

      const client = await ShadeClient.create({ rpc: mockProvider });
      const result = await client.balance();

      expect(createAccountObject).toHaveBeenCalledWith(
        testAccountId,
        mockProvider,
      );
      expect(mockAccount.getBalance).toHaveBeenCalled();
      expect(result).toBe(10);
    });

    it("should return 0 if account does not exist", async () => {
      setupClientMocks();
      const error = new Error("Account does not exist");
      (error as any).type = "AccountDoesNotExist";
      (mockAccount.getBalance as ReturnType<typeof vi.fn>).mockRejectedValue(
        error,
      );

      const client = await ShadeClient.create({ rpc: mockProvider });
      const result = await client.balance();

      expect(result).toBe(0);
    });

    it("should throw error for other account errors", async () => {
      setupClientMocks();
      const error = new Error("Network error");
      (mockAccount.getBalance as ReturnType<typeof vi.fn>).mockRejectedValue(
        error,
      );

      const client = await ShadeClient.create({ rpc: mockProvider });

      await expect(client.balance()).rejects.toThrow("Network error");
    });
  });

  describe("register", () => {
    it("should register agent successfully", async () => {
      setupClientMocks();
      const contractAttestation = {
        quote: [1, 2, 3],
        collateral: {
          pck_crl_issuer_chain: "",
          root_ca_crl: "",
          pck_crl: "",
          tcb_info_issuer_chain: "",
          tcb_info: "",
          tcb_info_signature: "",
          qe_identity_issuer_chain: "",
          qe_identity: "",
          qe_identity_signature: "",
        },
        tcb_info: {
          mrtd: "",
          rtmr0: "",
          rtmr1: "",
          rtmr2: "",
          rtmr3: "",
          os_image_hash: "",
          compose_hash: "",
          device_id: "",
          app_compose: "",
          event_log: [],
        },
      };
      vi.mocked(internalGetAttestation).mockResolvedValue(contractAttestation);
      (mockAccount.callFunction as ReturnType<typeof vi.fn>).mockResolvedValue(
        true,
      );

      const client = await ShadeClient.create({
        agentContractId: "agent.contract.testnet",
        rpc: mockProvider,
      });

      const result = await client.register();

      expect(internalGetAttestation).toHaveBeenCalledWith(
        undefined,
        testAccountId,
        false,
      );
      expect(ensureKeysSetup).toHaveBeenCalled();
      expect(mockAccount.callFunction).toHaveBeenCalledWith(
        expect.objectContaining({
          contractId: "agent.contract.testnet",
          methodName: "register_agent",
          args: { attestation: contractAttestation },
          deposit: "5000000000000000000000", // 0.005 NEAR
          gas: BigInt("300000000000000"),
        }),
      );
      expect(result).toBe(true);
    });

    it("should throw error if agentContractId is not configured", async () => {
      setupClientMocks();
      const client = await ShadeClient.create({ rpc: mockProvider });

      await expect(client.register()).rejects.toThrow(
        "agentContractId is required for registering the agent",
      );
    });

    it("should throw error if attestation fetch fails", async () => {
      setupClientMocks();
      vi.mocked(internalGetAttestation).mockRejectedValue(
        new Error("Network error"),
      );

      const client = await ShadeClient.create({
        agentContractId: "agent.contract.testnet",
        rpc: mockProvider,
      });

      await expect(client.register()).rejects.toThrow("Network error");
    });
  });

  describe("view", () => {
    it("should call view function on contract", async () => {
      setupClientMocks();
      const mockResponse = { result: "test" };
      (mockProvider.callFunction as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockResponse,
      );

      const client = await ShadeClient.create({
        agentContractId: "agent.contract.testnet",
        rpc: mockProvider,
      });

      const result = await client.view({
        methodName: "get_data",
        args: { key: "value" },
      });

      expect(mockProvider.callFunction).toHaveBeenCalledWith(
        "agent.contract.testnet",
        "get_data",
        { key: "value" },
        undefined,
      );
      expect(result).toEqual(mockResponse);
    });

    it("should throw error if agentContractId is not configured", async () => {
      setupClientMocks();
      const client = await ShadeClient.create({ rpc: mockProvider });

      await expect(
        client.view({ methodName: "test", args: {} }),
      ).rejects.toThrow("agentContractId is required for view calls");
    });
  });

  describe("call", () => {
    it("should call function on contract", async () => {
      setupClientMocks();
      const mockResponse = { result: "success" };
      (mockAccount.callFunction as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockResponse,
      );

      const client = await ShadeClient.create({
        agentContractId: "agent.contract.testnet",
        rpc: mockProvider,
      });

      const result = await client.call({
        methodName: "update_data",
        args: { key: "value" },
      });

      expect(ensureKeysSetup).toHaveBeenCalled();
      expect(getAgentSigner).toHaveBeenCalled();
      expect(createAccountObject).toHaveBeenCalled();
      expect(mockAccount.callFunction).toHaveBeenCalledWith(
        expect.objectContaining({
          contractId: "agent.contract.testnet",
          methodName: "update_data",
          args: { key: "value" },
        }),
      );
      expect(result).toEqual(mockResponse);
    });

    it("should call function with deposit and gas", async () => {
      setupClientMocks();
      const mockResponse = { result: "success" };
      (mockAccount.callFunction as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockResponse,
      );

      const client = await ShadeClient.create({
        agentContractId: "agent.contract.testnet",
        rpc: mockProvider,
      });

      const result = await client.call({
        methodName: "update_data",
        args: { key: "value" },
        deposit: "1000000000000000000000000", // 1 NEAR
        gas: BigInt("300000000000000"),
      });

      expect(mockAccount.callFunction).toHaveBeenCalledWith(
        expect.objectContaining({
          contractId: "agent.contract.testnet",
          methodName: "update_data",
          args: { key: "value" },
          deposit: "1000000000000000000000000",
          gas: BigInt("300000000000000"),
        }),
      );
      expect(result).toEqual(mockResponse);
    });

    it("should add keys if needed", async () => {
      setupClientMocks({ keysToAdd: [], wasChecked: false });
      const additionalKey = generateTestKey("additional-key");
      vi.mocked(ensureKeysSetup).mockResolvedValue({
        keysToAdd: [additionalKey],
        wasChecked: true,
      });

      const mockResponse = { result: "success" };
      (mockAccount.callFunction as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockResponse,
      );

      const client = await ShadeClient.create({
        agentContractId: "agent.contract.testnet",
        rpc: mockProvider,
        numKeys: 2,
      });

      await client.call({
        methodName: "update_data",
        args: {},
      });

      expect(ensureKeysSetup).toHaveBeenCalled();
      // Verify keys were added to the client
      const keys = client.getPrivateKeys(true);
      expect(keys).toContain(testPrivateKey);
      expect(keys).toContain(additionalKey);
    });

    it("should rotate keys on subsequent calls", async () => {
      setupClientMocks({ keysToAdd: [], wasChecked: false });
      // Set up 2 keys for rotation
      const secondKey = generateTestKey("second-key");
      // ensureKeysSetup is called for each call(), so first call adds the key, subsequent calls return empty
      vi.mocked(ensureKeysSetup)
        .mockResolvedValueOnce({
          keysToAdd: [secondKey],
          wasChecked: true,
        })
        .mockResolvedValue({
          keysToAdd: [], // Subsequent calls return empty since keysChecked is now true
          wasChecked: true,
        });

      // Mock getAgentSigner to simulate actual rotation behavior
      // First call: currentKeyIndex=0, increments to 1, returns keyIndex=1
      // Second call: currentKeyIndex=1, increments to 2, wraps to 0, returns keyIndex=0
      vi.mocked(getAgentSigner)
        .mockReturnValueOnce({
          signer: {} as any,
          keyIndex: 1, // First call increments from 0 to 1
        })
        .mockReturnValueOnce({
          signer: {} as any,
          keyIndex: 0, // Second call increments from 1 to 2, wraps to 0
        });

      const mockResponse = { result: "success" };
      (mockAccount.callFunction as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockResponse,
      );

      const client = await ShadeClient.create({
        agentContractId: "agent.contract.testnet",
        rpc: mockProvider,
        numKeys: 2,
      });

      await client.call({ methodName: "test1", args: {} });
      await client.call({ methodName: "test2", args: {} });

      expect(getAgentSigner).toHaveBeenCalledTimes(2);
      // First call starts with currentKeyIndex=0, keys array has 2 keys after ensureKeysSetup
      expect(getAgentSigner).toHaveBeenNthCalledWith(
        1,
        [testPrivateKey, secondKey],
        0,
      );
      // After first call, currentKeyIndex is updated to 1 (from getAgentSigner return)
      expect(getAgentSigner).toHaveBeenNthCalledWith(
        2,
        [testPrivateKey, secondKey],
        1,
      );
    });

    it("should throw error if agentContractId is not configured", async () => {
      setupClientMocks();
      const client = await ShadeClient.create({ rpc: mockProvider });

      await expect(
        client.call({ methodName: "test", args: {} }),
      ).rejects.toThrow("agentContractId is required for call functions");
    });
  });

  describe("getAttestation", () => {
    it("should return attestation", async () => {
      setupClientMocks();
      const attestation = createMockContractAttestation({ quote: [1, 2, 3] });
      vi.mocked(internalGetAttestation).mockResolvedValue(attestation);

      const client = await ShadeClient.create({});

      const result = await client.getAttestation();

      expect(internalGetAttestation).toHaveBeenCalledWith(
        undefined,
        testAccountId,
        false,
      );
      expect(result).toEqual(attestation);
    });

    it("should use TEE client if available", async () => {
      setupClientMocks({
        dstackClient: mockDstackClient,
        derivedWithTEE: true,
      });
      const attestation = createMockContractAttestation({ quote: [4, 5, 6] });
      vi.mocked(internalGetAttestation).mockResolvedValue(attestation);

      const client = await ShadeClient.create({});

      const result = await client.getAttestation();

      expect(internalGetAttestation).toHaveBeenCalledWith(
        mockDstackClient,
        testAccountId,
        true,
      );
      expect(result).toEqual(attestation);
    });
  });

  describe("fundAgent", () => {
    it("should fund agent account", async () => {
      setupClientMocks();
      vi.mocked(internalFundAgent).mockResolvedValue(undefined);

      const client = await ShadeClient.create({
        sponsor: {
          accountId: "sponsor.testnet",
          privateKey: "sponsor-key",
        },
        rpc: mockProvider,
      });

      await client.fund(10);

      expect(internalFundAgent).toHaveBeenCalledWith(
        testAccountId,
        "sponsor.testnet",
        "sponsor-key",
        10,
        mockProvider,
      );
    });

    it("should throw error if sponsor is not configured", async () => {
      setupClientMocks();
      const client = await ShadeClient.create({ rpc: mockProvider });

      await expect(client.fund(10)).rejects.toThrow(
        "sponsor is required for funding the agent account",
      );
    });
  });

  describe("getPrivateKeys", () => {
    it("should throw error if acknowledgeRisk is not true", async () => {
      setupClientMocks();
      const client = await ShadeClient.create({});

      expect(() => client.getPrivateKeys()).toThrow(
        "WARNING: Exporting private keys from the library is a risky operation",
      );

      expect(() => client.getPrivateKeys(false)).toThrow(
        "WARNING: Exporting private keys from the library is a risky operation",
      );
    });

    it("should return private keys when acknowledgeRisk is true", async () => {
      setupClientMocks();
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const client = await ShadeClient.create({});

      const keys = client.getPrivateKeys(true);

      expect(keys).toEqual([testPrivateKey]);
      expect(consoleSpy).toHaveBeenCalledWith(
        "WARNING: Exporting private keys from the library is a risky operation, you may accidentally leak them from the TEE. Do not use the keys to sign transactions other than to the agent contract.",
      );

      consoleSpy.mockRestore();
    });

    it("should return all keys including added keys", async () => {
      setupClientMocks({ keysToAdd: [], wasChecked: false });
      const additionalKey = generateTestKey("additional-key");
      vi.mocked(ensureKeysSetup).mockResolvedValue({
        keysToAdd: [additionalKey],
        wasChecked: true,
      });

      const mockResponse = { result: "success" };
      (mockAccount.callFunction as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockResponse,
      );

      const client = await ShadeClient.create({
        agentContractId: "agent.contract.testnet",
        rpc: mockProvider,
        numKeys: 2,
      });

      // Call a method to trigger key addition
      await client.call({ methodName: "test", args: {} });

      const keys = client.getPrivateKeys(true);

      expect(keys).toHaveLength(2);
      expect(keys).toContain(testPrivateKey);
      expect(keys).toContain(additionalKey);
    });
  });

  describe("isWhitelisted", () => {
    it("should throw error if agentContractId is not configured", async () => {
      setupClientMocks();
      const client = await ShadeClient.create({ rpc: mockProvider });

      await expect(client.isWhitelisted()).rejects.toThrow(
        "agentContractId is required for checking if the agent is whitelisted",
      );
    });

    it("should return null when contract requires TEE", async () => {
      setupClientMocks();
      (
        mockProvider.callFunction as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce({
        requires_tee: true,
        attestation_expiration_time_ms: "100000",
        owner_id: "owner.testnet",
        mpc_contract_id: "mpc.testnet",
      });

      const client = await ShadeClient.create({
        agentContractId: "agent.contract.testnet",
        rpc: mockProvider,
      });

      const result = await client.isWhitelisted();

      expect(mockProvider.callFunction).toHaveBeenCalledWith(
        "agent.contract.testnet",
        "get_contract_info",
        {},
        undefined,
      );
      expect(result).toBe(null);
    });

    it("should return true when agent is whitelisted", async () => {
      setupClientMocks();
      (mockProvider.callFunction as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          requires_tee: false,
          attestation_expiration_time_ms: "100000",
          owner_id: "owner.testnet",
          mpc_contract_id: "mpc.testnet",
        })
        .mockResolvedValueOnce([testAccountId, "other.agent.testnet"]); // whitelisted agents

      const client = await ShadeClient.create({
        agentContractId: "agent.contract.testnet",
        rpc: mockProvider,
      });

      const result = await client.isWhitelisted();

      expect(mockProvider.callFunction).toHaveBeenCalledTimes(2);
      expect(mockProvider.callFunction).toHaveBeenNthCalledWith(
        1,
        "agent.contract.testnet",
        "get_contract_info",
        {},
        undefined,
      );
      expect(mockProvider.callFunction).toHaveBeenNthCalledWith(
        2,
        "agent.contract.testnet",
        "get_whitelisted_agents_for_local",
        {},
        undefined,
      );
      expect(result).toBe(true);
    });

    it("should return false when agent is not whitelisted", async () => {
      setupClientMocks();
      (mockProvider.callFunction as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          requires_tee: false,
          attestation_expiration_time_ms: "100000",
          owner_id: "owner.testnet",
          mpc_contract_id: "mpc.testnet",
        })
        .mockResolvedValueOnce([
          "other.agent.testnet",
          "another.agent.testnet",
        ]); // whitelisted agents

      const client = await ShadeClient.create({
        agentContractId: "agent.contract.testnet",
        rpc: mockProvider,
      });

      const result = await client.isWhitelisted();

      expect(result).toBe(false);
    });
  });
});
