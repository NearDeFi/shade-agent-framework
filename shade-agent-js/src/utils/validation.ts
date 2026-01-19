import type { ShadeConfig } from "../api";
import { createDefaultProvider } from "./near";

// Validates and normalizes the ShadeConfig object
export async function validateShadeConfig(config: ShadeConfig): Promise<void> {
  // Set default networkId to 'testnet' if not provided
  if (config.networkId === undefined) {
    config.networkId = "testnet";
  }

  // Validate networkId
  if (config.networkId !== "testnet" && config.networkId !== "mainnet") {
    throw new Error("networkId must be either 'testnet' or 'mainnet'");
  }

  // Validate sponsor configuration if provided
  if (config.sponsor) {
    if (!config.sponsor.accountId || config.sponsor.accountId.trim() === "") {
      throw new Error(
        "sponsor.accountId is required when sponsor is provided",
      );
    }
    if (
      !config.sponsor.privateKey ||
      config.sponsor.privateKey.trim() === ""
    ) {
      throw new Error(
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
    throw new Error("numKeys must be an integer between 1 and 100");
  }

  // Create a default provider if one isn't provided
  if (!config.rpc) {
    config.rpc = createDefaultProvider(config.networkId);
  }

  // Validate that networkId matches the RPC provider's network
  const rpcNetworkId = await config.rpc.getNetworkId();
  if (rpcNetworkId !== config.networkId) {
    throw new Error(
      `Network ID mismatch: config.networkId is "${config.networkId}" but RPC provider is connected to "${rpcNetworkId}"`,
    );
  }
}
