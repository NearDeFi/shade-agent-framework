import { existsSync } from "fs";
import { DstackClient } from "@phala/dstack-sdk";
import {
  transformQuote,
  transformTcbInfo,
  getFakeAttestation,
  attestationForContract,
  type DstackAttestationForContract,
} from "./attestation-transform";
import { toThrowable, withRetry } from "./errors";
import { fetchCollateralWithFallback } from "./collateral";

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

// Detects if the application is running in a TEE
// If it is running in a TEE but this fails for whatever reason,
// then it will generate a deterministic account ID for the agent.
// This could be dangerous, however, it will not be able to register in the contract
// as it will not provide the attestation, which is required for registration.
// Regardless getDstackClient is only called once during setup of the client 
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
  keysDerivedWithRandom: boolean,
  pccsEndpoints: readonly string[],
): Promise<DstackAttestationForContract> {
  if (!dstackClient || !keysDerivedWithRandom) {
    // No TEE, or any key was path-derived (local-mode only).
    // Path-derived keys are blocked from producing a real attestation because
    // the same path produces the same account ID across callers.
    // The contract accepts this fake if requires_tee is false, rejects it otherwise.
    return getFakeAttestation();
  }

  try {
    // Get dstack info which contains tcb_info. Retried in case of transient
    // socket / TEE hiccups.
    const info = await withRetry(() => dstackClient.info());
    const dstackTcbInfo = info.tcb_info;

    // Get quote — include the agent's account id as the report data.
    // Report data is the account id as bytes padded to 64 bytes.
    const accountIdBytes = Buffer.from(agentAccountId, "hex");
    const reportData = Buffer.alloc(64);
    accountIdBytes.copy(reportData, 0);

    const quoteResponse = await withRetry(() =>
      dstackClient.getQuote(reportData),
    );
    const quote_hex = quoteResponse.quote;

    // Transform quote from hex string to bytes array.
    const quote = transformQuote(quote_hex);

    // Collateral comes from the configured PCCS ladder (see collateral.ts).
    const collateral = await fetchCollateralWithFallback(
      pccsEndpoints,
      Buffer.from(quote),
      new Date(),
    );

    // Transform tcb_info from dstack response to contract interface structure.
    const tcb_info = transformTcbInfo(dstackTcbInfo);

    return attestationForContract({ quote, collateral, tcb_info });
  } catch (error) {
    throw toThrowable(error);
  }
}
