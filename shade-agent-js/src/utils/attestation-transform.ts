import type { DstackAttestation, TcbInfo, Collateral, EventLog } from "./tee";
import type {
  TcbInfoV05x as DstackTcbInfo,
  EventLog as DstackEventLog,
} from "@phala/dstack-sdk";

// Raw collateral response from the endpoint
interface RawCollateral {
  pck_crl_issuer_chain?: string;
  root_ca_crl?: string; // hex string
  pck_crl?: string; // hex string
  tcb_info_issuer_chain?: string;
  tcb_info?: string;
  tcb_info_signature?: string; // hex string
  qe_identity_issuer_chain?: string;
  qe_identity?: string;
  qe_identity_signature?: string; // hex string
}

// Decodes a hex string to a byte array
function hexToBytes(hexStr: string | undefined): number[] {
  if (!hexStr || hexStr === "") {
    return [];
  }
  try {
    return Array.from(Buffer.from(hexStr, "hex"));
  } catch {
    throw new Error("Failed to decode hex string");
  }
}

// Converts a byte array to a hex string
function bytesToHex(bytes: number[]): string {
  if (bytes.length === 0) {
    return "";
  }
  return Buffer.from(bytes).toString("hex");
}

// Transforms a quote from hex string to bytes array
export function transformQuote(quoteHex: string): number[] {
  const cleanedHex = quoteHex.replace(/^0x/, "");
  return Array.from(Buffer.from(cleanedHex, "hex"));
}

// Transforms raw collateral response from the endpoint to Collateral structure
export function transformCollateral(rawCollateral: RawCollateral): Collateral {
  return {
    pck_crl_issuer_chain: rawCollateral.pck_crl_issuer_chain || "",
    root_ca_crl: hexToBytes(rawCollateral.root_ca_crl),
    pck_crl: hexToBytes(rawCollateral.pck_crl),
    tcb_info_issuer_chain: rawCollateral.tcb_info_issuer_chain || "",
    tcb_info: rawCollateral.tcb_info || "",
    tcb_info_signature: hexToBytes(rawCollateral.tcb_info_signature),
    qe_identity_issuer_chain: rawCollateral.qe_identity_issuer_chain || "",
    qe_identity: rawCollateral.qe_identity || "",
    qe_identity_signature: hexToBytes(rawCollateral.qe_identity_signature),
  };
}

// Transforms dstack TcbInfo to contract interface TcbInfo structure
export function transformTcbInfo(dstackTcbInfo: DstackTcbInfo): TcbInfo {
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

// Converts DstackAttestation to a format suitable for JSON serialization to the contract
export function attestationForContract(
  attestation: DstackAttestation,
): DstackAttestationForContract {
  return {
    quote: attestation.quote,
    collateral: {
      pck_crl_issuer_chain: attestation.collateral.pck_crl_issuer_chain,
      root_ca_crl: bytesToHex(attestation.collateral.root_ca_crl),
      pck_crl: bytesToHex(attestation.collateral.pck_crl),
      tcb_info_issuer_chain: attestation.collateral.tcb_info_issuer_chain,
      tcb_info: attestation.collateral.tcb_info,
      tcb_info_signature: bytesToHex(attestation.collateral.tcb_info_signature),
      qe_identity_issuer_chain: attestation.collateral.qe_identity_issuer_chain,
      qe_identity: attestation.collateral.qe_identity,
      qe_identity_signature: bytesToHex(
        attestation.collateral.qe_identity_signature,
      ),
    },
    tcb_info: attestation.tcb_info,
  };
}

// Creates a fake/empty DstackAttestation structure for non-TEE (requires_tee = false)
function getFakeAttestationInternal(): DstackAttestation {
  // TcbInfo fixed-size fields must be valid hex of the right length for contract deserialization
  const ZERO_48_HEX = "0".repeat(96); // 48 bytes
  const ZERO_32_HEX = "0".repeat(64); // 32 bytes

  return {
    quote: [],
    collateral: {
      pck_crl_issuer_chain: "",
      root_ca_crl: [],
      pck_crl: [],
      tcb_info_issuer_chain: "",
      tcb_info: "",
      tcb_info_signature: [],
      qe_identity_issuer_chain: "",
      qe_identity: "",
      qe_identity_signature: [],
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

// Creates a fake/empty DstackAttestationForContract structure for non-TEE (requires_tee = false)
export function getFakeAttestation(): DstackAttestationForContract {
  return attestationForContract(getFakeAttestationInternal());
}
