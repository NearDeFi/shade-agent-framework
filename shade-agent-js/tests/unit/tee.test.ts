import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "fs";
import { DstackClient } from "@phala/dstack-sdk";
import { getDstackClient, internalGetAttestation } from "../../src/utils/tee";
import {
  createMockDstackClient,
  createMockDstackTcbInfo,
  createMockDcapCollateral,
  freshTcbOrQeIdentityJson,
  synthFreshPckCrlBytes,
} from "../mocks/tee-mocks";
import { getFakeAttestation } from "../../src/utils/attestation-transform";

// Mock fs module
vi.mock("fs", () => ({
  existsSync: vi.fn(),
}));

// Mock DstackClient SDK
vi.mock("@phala/dstack-sdk", () => ({
  DstackClient: vi.fn(),
}));

// Mock @phala/dcap-qvl — the new collateral fetch primitive.
const mockGetCollateral = vi.fn();
vi.mock("@phala/dcap-qvl", () => ({
  getCollateral: (...args: unknown[]) => mockGetCollateral(...args),
  Quote: { parse: () => ({}) },
  PHALA_PCCS_URL: "https://pccs.phala.network",
  INTEL_PCS_URL: "https://api.trustedservices.intel.com",
}));

// Bypass the retry layer so per-attempt behaviour is asserted directly.
vi.mock("../../src/utils/errors", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("../../src/utils/errors");
  return {
    ...actual,
    withRetry: <T,>(fn: () => Promise<T>) => fn(),
  };
});

const DEFAULT_ENDPOINTS = [
  "https://pccs.phala.network",
  "https://api.trustedservices.intel.com",
];

describe("tee utils", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCollateral.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("getDstackClient", () => {
    it("should return undefined when socket does not exist", async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = await getDstackClient();
      expect(result).toBeUndefined();
      expect(existsSync).toHaveBeenCalledWith("/var/run/dstack.sock");
    });

    it("should return undefined when DstackClient constructor throws error", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.spyOn(DstackClient.prototype, "constructor" as any).mockImplementation(
        function () {
          throw new Error("Connection failed");
        },
      );

      const result = await getDstackClient();
      expect(result).toBeUndefined();
    });

    it("should return undefined when client.info() throws error", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const mockClient = createMockDstackClient();
      (mockClient.info as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Connection failed"),
      );
      vi.mocked(DstackClient).mockImplementation(function () {
        return mockClient;
      } as any);

      const result = await getDstackClient();
      expect(result).toBeUndefined();
      expect(mockClient.info).toHaveBeenCalled();
    });

    it("should return client when socket exists and client works", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const mockClient = createMockDstackClient();
      vi.mocked(DstackClient).mockImplementation(function () {
        return mockClient;
      } as any);

      const result = await getDstackClient();
      expect(result).toBe(mockClient);
      expect(mockClient.info).toHaveBeenCalled();
    });
  });

  describe("internalGetAttestation", () => {
    it("should return dummy attestation when no dstackClient", async () => {
      const result = await internalGetAttestation(
        undefined,
        "agent.testnet",
        false,
        DEFAULT_ENDPOINTS,
      );

      expect(result).toEqual(getFakeAttestation());
    });

    it("should return dummy attestation when keysDerivedWithRandom is false", async () => {
      const mockClient = createMockDstackClient();
      const result = await internalGetAttestation(
        mockClient,
        "agent.testnet",
        false,
        DEFAULT_ENDPOINTS,
      );

      expect(result).toEqual(getFakeAttestation());
      expect(mockClient.info).not.toHaveBeenCalled();
      expect(mockClient.getQuote).not.toHaveBeenCalled();
    });

    it("should fetch collateral from the first endpoint when it succeeds", async () => {
      const mockClient = createMockDstackClient();
      mockGetCollateral.mockResolvedValue(createMockDcapCollateral());
      // Implicit account id — 32 bytes of hex, as a TEE agent always has.
      const agentAccountId = "a".repeat(64);

      const result = await internalGetAttestation(
        mockClient,
        agentAccountId,
        true,
        DEFAULT_ENDPOINTS,
      );

      expect(mockClient.info).toHaveBeenCalled();

      // Report data binds the agent's account id into the quote: the account
      // id bytes at offset 0, zero-padded to 64. The contract rebuilds this
      // from predecessor_account_id and rejects registration if it differs.
      const reportData = vi.mocked(mockClient.getQuote).mock
        .calls[0][0] as Buffer;
      expect(reportData.length).toBe(64);
      expect(reportData.subarray(0, 32)).toEqual(
        Buffer.from(agentAccountId, "hex"),
      );
      expect(reportData.subarray(32)).toEqual(Buffer.alloc(32));

      // First (and only) call hits the first endpoint in the list.
      expect(mockGetCollateral).toHaveBeenCalledTimes(1);
      expect(mockGetCollateral).toHaveBeenCalledWith(
        "https://pccs.phala.network",
        expect.any(Buffer),
      );

      // Quote bytes passed to getCollateral are the same bytes used in the
      // contract-shaped result (post hex-decode).
      const passedBytes = mockGetCollateral.mock.calls[0][1] as Buffer;
      expect(passedBytes).toEqual(Buffer.from(result.quote));

      expect(result.quote).toBeDefined();
      expect(Array.isArray(result.quote)).toBe(true);
      expect(result.collateral).toBeDefined();
      expect(result.tcb_info).toBeDefined();
    });

    it("should use a custom endpoint list when provided", async () => {
      const mockClient = createMockDstackClient();
      mockGetCollateral.mockResolvedValue(createMockDcapCollateral());

      const custom = ["https://custom-pccs.example.com"];
      await internalGetAttestation(
        mockClient,
        "agent.testnet",
        true,
        custom,
      );

      expect(mockGetCollateral).toHaveBeenCalledWith(
        "https://custom-pccs.example.com",
        expect.any(Buffer),
      );
    });

    it("should fall through to the next endpoint when the first throws", async () => {
      const mockClient = createMockDstackClient();
      mockGetCollateral
        .mockRejectedValueOnce(new Error("primary down"))
        .mockResolvedValueOnce(createMockDcapCollateral());

      const result = await internalGetAttestation(
        mockClient,
        "agent.testnet",
        true,
        DEFAULT_ENDPOINTS,
      );

      expect(mockGetCollateral).toHaveBeenCalledTimes(2);
      // First call to primary, second call to fallback — order preserved.
      expect(mockGetCollateral.mock.calls[0][0]).toBe(
        "https://pccs.phala.network",
      );
      expect(mockGetCollateral.mock.calls[1][0]).toBe(
        "https://api.trustedservices.intel.com",
      );
      expect(result.collateral).toBeDefined();
    });

    it("should fall through when the first endpoint returns stale collateral (freshness ladder)", async () => {
      const mockClient = createMockDstackClient();
      const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
      const stale = createMockDcapCollateral({
        tcb_info: freshTcbOrQeIdentityJson(longAgo),
        qe_identity: freshTcbOrQeIdentityJson(longAgo),
        pck_crl: synthFreshPckCrlBytes(longAgo),
      });
      const fresh = createMockDcapCollateral();
      mockGetCollateral
        .mockResolvedValueOnce(stale)
        .mockResolvedValueOnce(fresh);

      const result = await internalGetAttestation(
        mockClient,
        "agent.testnet",
        true,
        DEFAULT_ENDPOINTS,
      );

      expect(mockGetCollateral).toHaveBeenCalledTimes(2);
      // The fresh result is the one returned to the caller.
      expect(result.collateral.tcb_info).toBe(fresh.tcb_info);
    });

    it("should throw an aggregated error when every endpoint fails", async () => {
      const mockClient = createMockDstackClient();
      mockGetCollateral
        .mockRejectedValueOnce(new Error("primary down"))
        .mockRejectedValueOnce(new Error("fallback down"));

      const settled = internalGetAttestation(
        mockClient,
        "agent.testnet",
        true,
        DEFAULT_ENDPOINTS,
      ).then(
        () => "ok",
        (e: unknown) => e as Error,
      );
      const result = await settled;

      expect(result).toBeInstanceOf(Error);
      const msg = (result as Error).message;
      expect(msg).toContain("All 2 PCCS endpoints failed");
      expect(msg).toContain("primary down");
      expect(msg).toContain("fallback down");
      // toThrowable keeps an AggregateError's per-endpoint errors reachable.
      const errors = (result as Error & { errors?: unknown[] }).errors;
      expect(errors).toHaveLength(2);
      expect((errors![0] as Error).message).toBe("primary down");
      expect((errors![1] as Error).message).toBe("fallback down");
      expect(mockGetCollateral).toHaveBeenCalledTimes(2);
    });

    it("should rethrow sanitised when a non-Error value is thrown", async () => {
      const mockClient = createMockDstackClient();
      mockGetCollateral.mockRejectedValue("String error");

      await expect(
        internalGetAttestation(
          mockClient,
          "agent.testnet",
          true,
          ["https://only-endpoint.example.com"],
        ),
      ).rejects.toThrow(/String error|An error occurred|PCCS endpoint/);
    });

    it("should transform tcb_info correctly", async () => {
      const mockClient = createMockDstackClient();
      const dstackTcbInfo = createMockDstackTcbInfo({
        mrtd: "mrtd_val",
        rtmr0: "rtmr0_val",
        rtmr1: "rtmr1_val",
        rtmr2: "rtmr2_val",
        rtmr3: "rtmr3_val",
        mr_aggregated: "mr_agg",
        os_image_hash: "os_hash",
        compose_hash: "compose_hash",
        device_id: "device_id",
        app_compose: "app_compose",
      });
      (mockClient.info as ReturnType<typeof vi.fn>).mockResolvedValue({
        tcb_info: dstackTcbInfo,
      });
      mockGetCollateral.mockResolvedValue(createMockDcapCollateral());

      const result = await internalGetAttestation(
        mockClient,
        "agent.testnet",
        true,
        DEFAULT_ENDPOINTS,
      );

      expect(result.tcb_info).toEqual({
        mrtd: "mrtd_val",
        rtmr0: "rtmr0_val",
        rtmr1: "rtmr1_val",
        rtmr2: "rtmr2_val",
        rtmr3: "rtmr3_val",
        os_image_hash: "os_hash",
        compose_hash: "compose_hash",
        device_id: "device_id",
        app_compose: "app_compose",
        event_log: [],
      });
    });

    it("should project dcap-qvl collateral into the contract shape (binary fields as hex strings)", async () => {
      const mockClient = createMockDstackClient();
      const freshTcb = freshTcbOrQeIdentityJson();
      const freshQe = freshTcbOrQeIdentityJson();
      const freshPckCrl = synthFreshPckCrlBytes();
      mockGetCollateral.mockResolvedValue(
        createMockDcapCollateral({
          pck_crl_issuer_chain: "chain3",
          root_ca_crl: [0x12, 0x34, 0x56, 0x78],
          pck_crl: freshPckCrl,
          tcb_info_issuer_chain: "chain1",
          tcb_info: freshTcb,
          tcb_info_signature: [0xde, 0xad, 0xbe, 0xef],
          qe_identity_issuer_chain: "chain2",
          qe_identity: freshQe,
          qe_identity_signature: [0xca, 0xfe, 0xba, 0xbe],
        }),
      );

      const result = await internalGetAttestation(
        mockClient,
        "agent.testnet",
        true,
        DEFAULT_ENDPOINTS,
      );

      expect(result.collateral.pck_crl_issuer_chain).toBe("chain3");
      expect(result.collateral.root_ca_crl).toBe("12345678");
      expect(result.collateral.pck_crl).toBe(Buffer.from(freshPckCrl).toString("hex"));
      expect(result.collateral.tcb_info_issuer_chain).toBe("chain1");
      expect(result.collateral.tcb_info).toBe(freshTcb);
      expect(result.collateral.tcb_info_signature).toBe("deadbeef");
      expect(result.collateral.qe_identity_issuer_chain).toBe("chain2");
      expect(result.collateral.qe_identity).toBe(freshQe);
      expect(result.collateral.qe_identity_signature).toBe("cafebabe");
    });
  });
});
