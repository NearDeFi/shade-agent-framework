import { existsSync } from "fs";
import { DstackClient } from "@phala/dstack-sdk";

export interface Attestation {
  quote_hex: string;
  collateral: string;
  checksum: string;
  tcb_info: string;
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

// Gets the TEE attestation for the agent
export async function internalGetAttestation(
  dstackClient: DstackClient | undefined,
  agentAccountId: string,
  keysDerivedWithTEE: boolean,
): Promise<Attestation> {
  if (!dstackClient || !keysDerivedWithTEE) {
    // If not in a TEE or keys were not derived with TEE, return a dummy attestation
    return {
      quote_hex: "not-in-a-tee",
      collateral: "not-in-a-tee",
      checksum: "not-in-a-tee",
      tcb_info: "not-in-a-tee",
    };
  } else {
    // If in a TEE, get real attestation
    const info = await dstackClient.info();
    // Convert tcb_info to string (always an object)
    const tcb_info: string = JSON.stringify(info.tcb_info);

    // Get quote 
    // Include the agent's account id as the report data
    const reportData = Buffer.from(agentAccountId, "utf-8");
    const ra = await dstackClient.getQuote(reportData);
    const quote_hex = ra.quote.replace(/^0x/, "");

    // Get quote collateral
    const formData = new FormData();
    formData.append("hex", quote_hex);

    // Get quote collateral
    let collateral: string, checksum: string;
    try {
      // Add timeout to prevent hanging indefinitely
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      const response = await fetch("https://proof.t16z.com/api/upload", {
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

      const resHelper = await response.json();
      checksum = resHelper.checksum;
      collateral = JSON.stringify(resHelper.quote_collateral);
    } catch (error) {
      throw new Error(
        `Failed to get quote collateral: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      quote_hex,
      collateral,
      checksum,
      tcb_info,
    };
  }
}
