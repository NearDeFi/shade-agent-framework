import type { TcbInfo, EventLog } from "./tee";
import type {
  TcbInfoV05x as DstackTcbInfo,
  EventLog as DstackEventLog,
} from "@phala/dstack-sdk";
import type { Collateral as DcapCollateral } from "@phala/dcap-qvl";
import { toThrowable } from "./errors";

// @phala/dcap-qvl types each binary collateral field as `number[] | string`.
// At runtime v0.3.9 always returns `number[]` (Array.from(Buffer)), but the
// type union is permissive. Encode both forms to a lowercase hex string —
// a string input is assumed to already be hex.
function bytesToHex(v: number[] | string | undefined): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v;
  if (v.length === 0) return "";
  return Buffer.from(v).toString("hex");
}

// Transforms a quote from hex string to bytes array
export function transformQuote(quoteHex: string): number[] {
  try {
    const cleanedHex = quoteHex.replace(/^0x/, "");
    return Array.from(Buffer.from(cleanedHex, "hex"));
  } catch (error) {
    throw toThrowable(error);
  }
}

// Transforms dstack TcbInfo to contract interface TcbInfo structure
export function transformTcbInfo(dstackTcbInfo: DstackTcbInfo): TcbInfo {
  try {
    return {
      mrtd: dstackTcbInfo.mrtd || "",
      rtmr0: dstackTcbInfo.rtmr0 || "",
      rtmr1: dstackTcbInfo.rtmr1 || "",
      rtmr2: dstackTcbInfo.rtmr2 || "",
      rtmr3: dstackTcbInfo.rtmr3 || "",
      os_image_hash: dstackTcbInfo.os_image_hash || "",
      compose_hash: dstackTcbInfo.compose_hash || "",
      device_id: dstackTcbInfo.device_id || "",
      app_compose: dstackTcbInfo.app_compose || "",
      event_log: (dstackTcbInfo.event_log || []).map(
        (event: DstackEventLog): EventLog => ({
          imr: event.imr,
          event_type: event.event_type,
          digest: event.digest,
          event: event.event,
          event_payload: event.event_payload,
        }),
      ),
    };
  } catch (error) {
    throw toThrowable(error);
  }
}

// Contract-formatted attestation structure (ready to be sent to the contract)
export interface DstackAttestationForContract {
  quote: number[];
  collateral: {
    pck_crl_issuer_chain: string;
    root_ca_crl: string; // hex string
    pck_crl: string; // hex string
    tcb_info_issuer_chain: string;
    tcb_info: string;
    tcb_info_signature: string; // hex string
    qe_identity_issuer_chain: string;
    qe_identity: string;
    qe_identity_signature: string; // hex string
  };
  tcb_info: TcbInfo;
}

// Inputs to attestationForContract: the raw pieces produced by the dstack
// + PCCS pipeline (quote bytes, dcap-qvl collateral, transformed tcb_info).
// The function is the single boundary where binary fields are encoded to
// hex for the contract wire format.
export interface AttestationInputs {
  quote: number[];
  collateral: DcapCollateral;
  tcb_info: TcbInfo;
}

// Builds the contract-shaped attestation by hex-encoding dcap-qvl's binary
// collateral fields and passing through the rest. This is the only place
// the byte→hex conversion happens in the agent pipeline.
export function attestationForContract(
  inputs: AttestationInputs,
): DstackAttestationForContract {
  try {
    return {
      quote: inputs.quote,
      collateral: {
        pck_crl_issuer_chain: inputs.collateral.pck_crl_issuer_chain,
        root_ca_crl: bytesToHex(inputs.collateral.root_ca_crl),
        pck_crl: bytesToHex(inputs.collateral.pck_crl),
        tcb_info_issuer_chain: inputs.collateral.tcb_info_issuer_chain,
        tcb_info: inputs.collateral.tcb_info,
        tcb_info_signature: bytesToHex(inputs.collateral.tcb_info_signature),
        qe_identity_issuer_chain: inputs.collateral.qe_identity_issuer_chain,
        qe_identity: inputs.collateral.qe_identity,
        qe_identity_signature: bytesToHex(
          inputs.collateral.qe_identity_signature,
        ),
      },
      tcb_info: inputs.tcb_info,
    };
  } catch (error) {
    throw toThrowable(error);
  }
}

// Creates a fake/empty DstackAttestationForContract structure for non-TEE
// (requires_tee = false). TcbInfo fixed-size fields are zero hex of the
// correct length so the contract's borsh deserialization accepts them.
export function getFakeAttestation(): DstackAttestationForContract {
  const ZERO_48_HEX = "0".repeat(96); // 48 bytes
  const ZERO_32_HEX = "0".repeat(64); // 32 bytes

  return {
    quote: [],
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
      mrtd: ZERO_48_HEX,
      rtmr0: ZERO_48_HEX,
      rtmr1: ZERO_48_HEX,
      rtmr2: ZERO_48_HEX,
      rtmr3: ZERO_48_HEX,
      os_image_hash: "",
      compose_hash: ZERO_32_HEX,
      device_id: ZERO_32_HEX,
      app_compose: "",
      event_log: [],
    },
  };
}
