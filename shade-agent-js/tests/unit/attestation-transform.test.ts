import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  transformQuote,
  transformCollateral,
  transformTcbInfo,
  attestationForContract,
  getFakeAttestation,
} from "../../src/utils/attestation-transform";
import type { TcbInfoV05x as DstackTcbInfo } from "@phala/dstack-sdk";
import { createMockAttestation } from "../test-utils";
import {
  createMockDstackTcbInfo,
  createMockQuoteCollateral,
} from "../mocks/tee-mocks";

describe("attestation-transform", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("transformQuote", () => {
    it("should transform hex string without 0x prefix to bytes array", () => {
      const hexStr = "deadbeef";
      const result = transformQuote(hexStr);
      expect(result).toEqual([222, 173, 190, 239]);
    });

    it("should remove 0x prefix and transform to bytes array", () => {
      const hexStr = "0xdeadbeef";
      const result = transformQuote(hexStr);
      expect(result).toEqual([222, 173, 190, 239]);
    });

    it("should handle empty hex string", () => {
      const hexStr = "";
      const result = transformQuote(hexStr);
      expect(result).toEqual([]);
    });

    it("should handle hex string with only 0x prefix", () => {
      const hexStr = "0x";
      const result = transformQuote(hexStr);
      expect(result).toEqual([]);
    });

    it("should handle longer hex strings", () => {
      const hexStr = "0123456789abcdef";
      const result = transformQuote(hexStr);
      expect(result).toEqual([1, 35, 69, 103, 137, 171, 205, 239]);
    });

    it("should handle uppercase hex strings", () => {
      const hexStr = "DEADBEEF";
      const result = transformQuote(hexStr);
      expect(result).toEqual([222, 173, 190, 239]);
    });
  });

  describe("transformCollateral", () => {
    it("should transform complete raw collateral to Collateral structure", () => {
      const rawCollateral = createMockQuoteCollateral({
        pck_crl_issuer_chain: "chain1",
        root_ca_crl: "deadbeef",
        pck_crl: "cafebabe",
        tcb_info_issuer_chain: "chain2",
        tcb_info: "tcb_info_json",
        tcb_info_signature: "7369676e617475726531",
        qe_identity_issuer_chain: "chain3",
        qe_identity: "qe_identity_json",
        qe_identity_signature: "7369676e617475726532",
      });

      const result = transformCollateral(rawCollateral);

      expect(result.pck_crl_issuer_chain).toBe("chain1");
      expect(result.root_ca_crl).toEqual([222, 173, 190, 239]);
      expect(result.pck_crl).toEqual([202, 254, 186, 190]);
      expect(result.tcb_info_issuer_chain).toBe("chain2");
      expect(result.tcb_info).toBe("tcb_info_json");
      expect(result.tcb_info_signature).toEqual([
        115, 105, 103, 110, 97, 116, 117, 114, 101, 49,
      ]);
      expect(result.qe_identity_issuer_chain).toBe("chain3");
      expect(result.qe_identity).toBe("qe_identity_json");
      expect(result.qe_identity_signature).toEqual([
        115, 105, 103, 110, 97, 116, 117, 114, 101, 50,
      ]);
    });

    it("should handle empty/undefined hex fields by converting to empty arrays", () => {
      const rawCollateral = createMockQuoteCollateral({
        pck_crl_issuer_chain: "chain1",
        root_ca_crl: "",
        pck_crl: undefined,
        tcb_info_issuer_chain: "",
        tcb_info: "tcb_info",
        tcb_info_signature: "",
        qe_identity_issuer_chain: undefined,
        qe_identity: "",
        qe_identity_signature: undefined,
      });

      const result = transformCollateral(rawCollateral);

      expect(result.root_ca_crl).toEqual([]);
      expect(result.pck_crl).toEqual([]);
      expect(result.tcb_info_signature).toEqual([]);
      expect(result.qe_identity_signature).toEqual([]);
      expect(result.pck_crl_issuer_chain).toBe("chain1");
      expect(result.tcb_info_issuer_chain).toBe("");
      expect(result.qe_identity_issuer_chain).toBe("");
    });

    it("should handle completely empty raw collateral", () => {
      const rawCollateral = createMockQuoteCollateral();

      const result = transformCollateral(rawCollateral);

      expect(result.pck_crl_issuer_chain).toBe("");
      expect(result.root_ca_crl).toEqual([]);
      expect(result.pck_crl).toEqual([]);
      expect(result.tcb_info_issuer_chain).toBe("");
      expect(result.tcb_info).toBe("");
      expect(result.tcb_info_signature).toEqual([]);
      expect(result.qe_identity_issuer_chain).toBe("");
      expect(result.qe_identity).toBe("");
      expect(result.qe_identity_signature).toEqual([]);
    });

    it("should handle hex strings with 0x prefix", () => {
      const rawCollateral = createMockQuoteCollateral({
        root_ca_crl: "0xdeadbeef",
        tcb_info_signature: "0xcafebabe",
      });

      const result = transformCollateral(rawCollateral);

      expect(result.root_ca_crl).toBeDefined();
      expect(result.tcb_info_signature).toBeDefined();
      expect(Array.isArray(result.root_ca_crl)).toBe(true);
      expect(Array.isArray(result.tcb_info_signature)).toBe(true);
    });

    it("should throw error when hex decoding fails", () => {
      // Mock Buffer.from to throw to test error handling path (does not propagate upstream error to avoid leaking sensitive data)
      const originalFrom = Buffer.from;
      vi.spyOn(Buffer, "from").mockImplementationOnce((...args: any[]) => {
        if (args.length > 1 && args[1] === "hex") {
          throw new Error("Invalid hex character");
        }
        return originalFrom.apply(Buffer, args as any);
      });

      const rawCollateral = createMockQuoteCollateral({
        root_ca_crl: "deadbeef",
      });

      expect(() => transformCollateral(rawCollateral)).toThrow(
        "Failed to decode hex string",
      );
    });
  });

  describe("transformTcbInfo", () => {
    it("should transform complete dstack TcbInfo to contract TcbInfo", () => {
      const dstackTcbInfo = createMockDstackTcbInfo({
        mrtd: "mrtd_value",
        rtmr0: "rtmr0_value",
        rtmr1: "rtmr1_value",
        rtmr2: "rtmr2_value",
        rtmr3: "rtmr3_value",
        mr_aggregated: "mr_aggregated_value",
        os_image_hash: "os_hash",
        compose_hash: "compose_hash",
        device_id: "device_id",
        app_compose: "app_compose_json",
        event_log: [
          {
            imr: 1,
            event_type: 2,
            digest: "digest1",
            event: "event1",
            event_payload: "payload1",
          },
          {
            imr: 3,
            event_type: 4,
            digest: "digest2",
            event: "event2",
            event_payload: "payload2",
          },
        ],
      });

      const result = transformTcbInfo(dstackTcbInfo);

      expect(result.mrtd).toBe("mrtd_value");
      expect(result.rtmr0).toBe("rtmr0_value");
      expect(result.rtmr1).toBe("rtmr1_value");
      expect(result.rtmr2).toBe("rtmr2_value");
      expect(result.rtmr3).toBe("rtmr3_value");
      expect(result.os_image_hash).toBe("os_hash");
      expect(result.compose_hash).toBe("compose_hash");
      expect(result.device_id).toBe("device_id");
      expect(result.app_compose).toBe("app_compose_json");
      expect(result.event_log).toHaveLength(2);
      expect(result.event_log[0]).toEqual({
        imr: 1,
        event_type: 2,
        digest: "digest1",
        event: "event1",
        event_payload: "payload1",
      });
      expect(result.event_log[1]).toEqual({
        imr: 3,
        event_type: 4,
        digest: "digest2",
        event: "event2",
        event_payload: "payload2",
      });
    });

    it("should handle empty/undefined fields with empty strings", () => {
      const dstackTcbInfo = {
        mrtd: "",
        rtmr0: undefined as any,
        rtmr1: "",
        rtmr2: undefined as any,
        rtmr3: "",
        mr_aggregated: "",
        os_image_hash: "",
        compose_hash: undefined as any,
        device_id: "",
        app_compose: undefined as any,
        event_log: undefined as any,
      } as DstackTcbInfo;

      const result = transformTcbInfo(dstackTcbInfo);

      expect(result.mrtd).toBe("");
      expect(result.rtmr0).toBe("");
      expect(result.rtmr1).toBe("");
      expect(result.rtmr2).toBe("");
      expect(result.rtmr3).toBe("");
      expect(result.os_image_hash).toBe("");
      expect(result.compose_hash).toBe("");
      expect(result.device_id).toBe("");
      expect(result.app_compose).toBe("");
      expect(result.event_log).toEqual([]);
    });

    it("should handle empty event_log array", () => {
      const dstackTcbInfo = createMockDstackTcbInfo({
        mrtd: "mrtd",
        rtmr0: "rtmr0",
        rtmr1: "rtmr1",
        rtmr2: "rtmr2",
        rtmr3: "rtmr3",
        mr_aggregated: "mr_agg",
        os_image_hash: "hash",
        compose_hash: "compose",
        device_id: "device",
        app_compose: "compose",
      });

      const result = transformTcbInfo(dstackTcbInfo);

      expect(result.event_log).toEqual([]);
    });
  });

  describe("attestationForContract", () => {
    it("should convert DstackAttestation to contract format with hex strings", () => {
      const attestation = createMockAttestation({
        quote: [1, 2, 3, 4],
        collateral: {
          pck_crl_issuer_chain: "chain1",
          root_ca_crl: [222, 173, 190, 239],
          pck_crl: [202, 254, 186, 190],
          tcb_info_issuer_chain: "chain2",
          tcb_info: "tcb_info",
          tcb_info_signature: [115, 105, 103, 110],
          qe_identity_issuer_chain: "chain3",
          qe_identity: "qe_identity",
          qe_identity_signature: [115, 105, 103, 50],
        },
        tcb_info: {
          mrtd: "mrtd",
          rtmr0: "rtmr0",
          rtmr1: "rtmr1",
          rtmr2: "rtmr2",
          rtmr3: "rtmr3",
          os_image_hash: "hash",
          compose_hash: "compose",
          device_id: "device",
          app_compose: "compose",
          event_log: [],
        },
      });

      const result = attestationForContract(attestation);

      expect(result.quote).toEqual([1, 2, 3, 4]);
      expect(result.collateral.pck_crl_issuer_chain).toBe("chain1");
      expect(result.collateral.root_ca_crl).toBe("deadbeef");
      expect(result.collateral.pck_crl).toBe("cafebabe");
      expect(result.collateral.tcb_info_issuer_chain).toBe("chain2");
      expect(result.collateral.tcb_info).toBe("tcb_info");
      expect(result.collateral.tcb_info_signature).toBe("7369676e");
      expect(result.collateral.qe_identity_issuer_chain).toBe("chain3");
      expect(result.collateral.qe_identity).toBe("qe_identity");
      expect(result.collateral.qe_identity_signature).toBe("73696732");
      expect(result.tcb_info).toEqual(attestation.tcb_info);
    });

    it("should convert empty byte arrays to empty hex strings", () => {
      const attestation = createMockAttestation();

      const result = attestationForContract(attestation);

      expect(result.quote).toEqual([]);
      expect(result.collateral.root_ca_crl).toBe("");
      expect(result.collateral.pck_crl).toBe("");
      expect(result.collateral.tcb_info_signature).toBe("");
      expect(result.collateral.qe_identity_signature).toBe("");
    });
  });

  describe("getFakeAttestation", () => {
    it("should return fake attestation with correct structure", () => {
      const result = getFakeAttestation();

      expect(result).toHaveProperty("quote");
      expect(result).toHaveProperty("collateral");
      expect(result).toHaveProperty("tcb_info");
      expect(result.quote).toEqual([]);
    });

    it("should have empty collateral fields", () => {
      const result = getFakeAttestation();

      expect(result.collateral.pck_crl_issuer_chain).toBe("");
      expect(result.collateral.root_ca_crl).toBe(""); // Empty array becomes empty hex string
      expect(result.collateral.pck_crl).toBe(""); // Empty array becomes empty hex string
      expect(result.collateral.tcb_info_issuer_chain).toBe("");
      expect(result.collateral.tcb_info).toBe("");
      expect(result.collateral.tcb_info_signature).toBe(""); // Empty array becomes empty hex string
      expect(result.collateral.qe_identity_issuer_chain).toBe("");
      expect(result.collateral.qe_identity).toBe("");
      expect(result.collateral.qe_identity_signature).toBe(""); // Empty array becomes empty hex string
    });

    it("should have TcbInfo with correct hex lengths for fixed-size fields", () => {
      const result = getFakeAttestation();

      // 48 bytes = 96 hex characters
      expect(result.tcb_info.mrtd).toHaveLength(96);
      expect(result.tcb_info.rtmr0).toHaveLength(96);
      expect(result.tcb_info.rtmr1).toHaveLength(96);
      expect(result.tcb_info.rtmr2).toHaveLength(96);
      expect(result.tcb_info.rtmr3).toHaveLength(96);

      // 32 bytes = 64 hex characters
      expect(result.tcb_info.compose_hash).toHaveLength(64);
      expect(result.tcb_info.device_id).toHaveLength(64);

      // Optional fields can be empty
      expect(result.tcb_info.os_image_hash).toBe("");
      expect(result.tcb_info.app_compose).toBe("");
      expect(result.tcb_info.event_log).toEqual([]);
    });

    it("should have all TcbInfo hex fields filled with zeros", () => {
      const result = getFakeAttestation();

      expect(result.tcb_info.mrtd).toBe("0".repeat(96));
      expect(result.tcb_info.rtmr0).toBe("0".repeat(96));
      expect(result.tcb_info.rtmr1).toBe("0".repeat(96));
      expect(result.tcb_info.rtmr2).toBe("0".repeat(96));
      expect(result.tcb_info.rtmr3).toBe("0".repeat(96));
      expect(result.tcb_info.compose_hash).toBe("0".repeat(64));
      expect(result.tcb_info.device_id).toBe("0".repeat(64));
    });

    it("should return consistent results on multiple calls", () => {
      const result1 = getFakeAttestation();
      const result2 = getFakeAttestation();

      expect(result1).toEqual(result2);
    });
  });
});
