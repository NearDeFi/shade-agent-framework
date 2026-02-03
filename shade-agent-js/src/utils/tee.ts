import { existsSync } from "fs";
import { DstackClient } from "@phala/dstack-sdk";
import {
  transformQuote,
  transformCollateral,
  transformTcbInfo,
  getFakeAttestation,
  attestationForContract,
  type DstackAttestationForContract,
} from "./attestation-transform";

// DstackAttestation structure matching the contract interface
export interface DstackAttestation {
  quote: number[]; // Vec<u8> - quote as bytes array
  collateral: Collateral;
  tcb_info: TcbInfo;
}

// Collateral structure matching the contract interface
export interface Collateral {
  pck_crl_issuer_chain: string;
  root_ca_crl: number[]; // Vec<u8>
  pck_crl: number[]; // Vec<u8>
  tcb_info_issuer_chain: string;
  tcb_info: string;
  tcb_info_signature: number[]; // Vec<u8>
  qe_identity_issuer_chain: string;
  qe_identity: string;
  qe_identity_signature: number[]; // Vec<u8>
}

// TcbInfo structure matching the contract interface
export interface TcbInfo {
  mrtd: string;
  rtmr0: string;
  rtmr1: string;
  rtmr2: string;
  rtmr3: string;
  os_image_hash: string; 
  compose_hash: string;
  device_id: string;
  app_compose: string;
  event_log: EventLog[];
}

export interface EventLog {
  imr: number;
  event_type: number;
  digest: string;
  event: string;
  event_payload: string;
}

interface QuoteCollateralResponse {
  checksum?: string;
  quote_collateral: {
    pck_crl_issuer_chain?: string;
    root_ca_crl?: string;
    pck_crl?: string;
    tcb_info_issuer_chain?: string;
    tcb_info?: string;
    tcb_info_signature?: string;
    qe_identity_issuer_chain?: string;
    qe_identity?: string;
    qe_identity_signature?: string;
  };
}

// Detects if the application is running in a TEE
// If it is running in a TEE but this fails for whatever reason,
// then it will generate a deterministic account ID for the agent.
// This could be dangerous, however, it will not be able to register in the contract
// as it will not provide the attestation, which is required for registration.
export async function getDstackClient(): Promise<DstackClient | undefined> {
  // First check if socket exists
  if (!existsSync("/var/run/dstack.sock")) {
    return undefined;
  }

  // Then test if Dstack client actually works, if so return the client
  try {
    const client = new DstackClient();
    await client.info();
    return client;
  } catch {
    return undefined;
  }
}

// Gets the TEE attestation for the agent in contract format
// Returns DstackAttestationForContract structure ready to be sent to the contract
export async function internalGetAttestation(
  dstackClient: DstackClient | undefined,
  agentAccountId: string,
  keysDerivedWithTEE: boolean,
): Promise<DstackAttestationForContract> {
  if (!dstackClient || !keysDerivedWithTEE) {
    // If not in a TEE or keys were not derived with TEE, return a fake/empty attestation
    // The contract will accept this if requires_tee is false, or reject it if requires_tee is true
    return getFakeAttestation();
  }

  // Get dstack info which contains tcb_info
  const info = await dstackClient.info();
  const dstackTcbInfo = info.tcb_info;

  // Get quote - include the agent's account id as the report data
  // Report data is the account id as bytes padded to 64 bytes
  const accountIdBytes = Buffer.from(agentAccountId, "hex");
  const reportData = Buffer.alloc(64);
  accountIdBytes.copy(reportData, 0);

  const quoteResponse = await dstackClient.getQuote(reportData);
  const quote_hex = quoteResponse.quote;

  // Transform quote from hex string to bytes array
  const quote = transformQuote(quote_hex);

  // Get quote collateral from Phala endpoint
  const formData = new FormData();
  formData.append("hex", quote_hex.replace(/^0x/, ""));

  let collateral: Collateral;
  try {
    // Add timeout to prevent hanging indefinitely
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    const collateralUrl =
      "https://cloud-api.phala.network/api/v1/attestations/verify";

    const response = await fetch(collateralUrl, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(
        `Failed to get quote collateral: HTTP ${response.status}`,
      );
    }

    const resHelper = (await response.json()) as QuoteCollateralResponse;
    collateral = transformCollateral(resHelper.quote_collateral);
  } catch (error) {
    throw new Error(
      `Failed to get quote collateral: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Transform tcb_info from dstack response to contract interface structure
  const tcb_info = transformTcbInfo(dstackTcbInfo);

  // Convert to contract format
  const attestation: DstackAttestation = {
    quote,
    collateral,
    tcb_info,
  };

  return attestationForContract(attestation);
}
