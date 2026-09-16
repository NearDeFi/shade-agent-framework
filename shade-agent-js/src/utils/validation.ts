import type { ShadeConfig } from "../api";
import { createDefaultProvider } from "./near";
import { DEFAULT_PCCS_ENDPOINTS } from "./collateral";
import { genericError, toThrowable } from "./errors";

// Validates and normalizes the ShadeConfig object
export async function validateShadeConfig(config: ShadeConfig): Promise<void> {
  // Set default networkId to 'testnet' if not provided
  if (config.networkId === undefined) {
    config.networkId = "testnet";
  }

  // Validate networkId
  if (config.networkId !== "testnet" && config.networkId !== "mainnet") {
    throw genericError("networkId must be either 'testnet' or 'mainnet'");
  }

  // Validate sponsor configuration if provided
  if (config.sponsor) {
    if (!config.sponsor.accountId || config.sponsor.accountId.trim() === "") {
      throw genericError(
        "sponsor.accountId is required when sponsor is provided",
      );
    }
    if (
      !config.sponsor.privateKey ||
      config.sponsor.privateKey.trim() === ""
    ) {
      throw genericError(
        "sponsor.privateKey is required when sponsor is provided",
      );
    }
  }

  // Set default numKeys to 1 if undefined
  if (config.numKeys === undefined) {
    config.numKeys = 1;
  }
  // Validate numKeys
  if (
    !Number.isInteger(config.numKeys) ||
    config.numKeys < 1 ||
    config.numKeys > 100
  ) {
    throw genericError("numKeys must be an integer between 1 and 100");
  }

  // Validate pccsEndpoints: default to Phala PCCS → Intel PCS fallback ladder
  // when undefined; reject explicit empty arrays; reject malformed /
  // non-http(s) URLs. Collateral GETs are unauthenticated and the client
  // appends the certification paths itself, so credentials, query or
  // fragment in a base URL are always a mistake (and credentials would
  // otherwise surface in error messages).
  if (config.pccsEndpoints === undefined) {
    config.pccsEndpoints = [...DEFAULT_PCCS_ENDPOINTS];
  } else {
    if (!Array.isArray(config.pccsEndpoints)) {
      throw genericError("pccsEndpoints must be an array of URL strings");
    }
    if (config.pccsEndpoints.length === 0) {
      throw genericError("pccsEndpoints must be a non-empty array");
    }
    const normalized: string[] = [];
    for (const raw of config.pccsEndpoints) {
      if (typeof raw !== "string" || raw.trim() === "") {
        throw genericError("pccsEndpoints entries must be non-empty strings");
      }
      const entry = raw.trim();
      let parsed: URL;
      try {
        parsed = new URL(entry);
      } catch {
        throw genericError("pccsEndpoints entries must be valid URLs");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw genericError(
          "pccsEndpoints entries must use http or https protocol",
        );
      }
      if (
        parsed.username ||
        parsed.password ||
        entry.includes("?") ||
        entry.includes("#")
      ) {
        throw genericError(
          "pccsEndpoints entries must not contain credentials, query or fragment",
        );
      }
      normalized.push(entry);
    }
    config.pccsEndpoints = normalized;
  }

  try {
    if (!config.rpc) {
      config.rpc = createDefaultProvider(config.networkId);
    }

    const rpcNetworkId = await config.rpc.getNetworkId();
    if (rpcNetworkId !== config.networkId) {
      throw genericError(
        `Network ID mismatch: config.networkId is "${config.networkId}" but RPC provider is connected to "${rpcNetworkId}"`,
      );
    }
  } catch (error) {
    throw toThrowable(error);
  }
}
