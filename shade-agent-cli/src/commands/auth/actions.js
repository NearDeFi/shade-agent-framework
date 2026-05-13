import {
  getNearCredentials,
  getPhalaKey,
  setPhalaKey,
  deleteNearCredentials,
  deletePhalaKey,
  getRpcConfig,
  setRpcConfig,
  deleteRpcConfig,
} from "../../utils/keystore.js";
import { isExitPromptError } from "../../utils/error-handler.js";
import { JsonRpcProvider } from "@near-js/providers";
import chalk from "chalk";
import {
  selectCredentialType,
  selectNetwork,
  promptForPhalaKey,
  promptForRpcConfig,
} from "./prompts.js";
import { promptAndStoreCredentials } from "./credentials.js";

// Probe a candidate RPC URL + optional API key by issuing the `status`
// JSON-RPC method. Red+exit if the endpoint is unreachable, rejects auth,
// or reports a chain_id that doesn't match the selected network.
async function verifyRpcOrExit(url, apiKey, expectedNetwork) {
  const headers = apiKey
    ? { Authorization: `Bearer ${apiKey}` }
    : undefined;
  const candidate = new JsonRpcProvider(
    { url, headers },
    { retries: 0, backoff: 1, wait: 0 },
  );
  let status;
  try {
    status = await candidate.status();
  } catch (_) {
    console.log(
      chalk.red(`Error: RPC at ${url} is not working, try a different RPC provider`),
    );
    process.exit(1);
  }
  if (status?.chain_id && status.chain_id !== expectedNetwork) {
    console.log(
      chalk.red(
        `Error: RPC at ${url} is on chain '${status.chain_id}' but you selected '${expectedNetwork}'`,
      ),
    );
    process.exit(1);
  }
}

async function setRpcForNetwork(network) {
  const { url, apiKey } = await promptForRpcConfig();
  await verifyRpcOrExit(url, apiKey, network);
  await setRpcConfig(network, url, apiKey);
  console.log(chalk.green(`✓ RPC config stored for ${network}`));
  console.log(chalk.cyan(`  URL: ${url}`));
  console.log(chalk.cyan(`  API key: ${apiKey ? "(set)" : "(none)"}`));
}

// Set credentials action
export async function setCredentials(
  whatToSetArg,
  networkArg = null,
  credentialOptionArg = null,
) {
  try {
    const whatToSet = await selectCredentialType(whatToSetArg, "set");

    // Both 'near' and 'rpc' subtypes need a network. Prompt once and reuse.
    let network = null;
    if (whatToSet === "near" || whatToSet === "rpc" || whatToSet === "all") {
      network = await selectNetwork(networkArg);
    }

    if (whatToSet === "near" || whatToSet === "all") {
      await promptAndStoreCredentials(network, credentialOptionArg);
    }

    if (whatToSet === "phala" || whatToSet === "all") {
      // Prompt for PHALA API key (will replace if it exists)
      const phalaKey = await promptForPhalaKey();

      const trimmedKey = phalaKey.trim();
      await setPhalaKey(trimmedKey);
      console.log(chalk.green("✓ PHALA API key stored"));
      console.log(chalk.green("\nStored PHALA API key:"));
      console.log(chalk.cyan(`  ${trimmedKey}`));
    }

    if (whatToSet === "rpc" || whatToSet === "all") {
      await setRpcForNetwork(network);
    }
  } catch (error) {
    // ExitPromptError is handled globally in cli.js
    if (isExitPromptError(error)) {
      process.exit(0);
    }
    console.log(chalk.red(`Error: ${error.message}`));
    process.exit(1);
  }
}

// Get credentials action
export async function getCredentials(whatToGetArg, networkArg = null) {
  try {
    const whatToGet = await selectCredentialType(whatToGetArg, "get");

    let network = null;
    if (whatToGet === "near" || whatToGet === "rpc" || whatToGet === "all") {
      network = await selectNetwork(networkArg);
    }

    if (whatToGet === "near" || whatToGet === "all") {
      const credentials = await getNearCredentials(network);

      if (!credentials) {
        console.log(chalk.yellow(`No master account found for ${network}`));
        console.log(chalk.yellow(`Use 'shade auth set' to set master account`));
      } else {
        console.log(chalk.green(`\nMaster account for ${network}:`));
        console.log(chalk.cyan(`Account ID: ${credentials.accountId}`));
        console.log(chalk.cyan(`Private Key: ${credentials.privateKey}`));
      }
    }

    if (whatToGet === "phala" || whatToGet === "all") {
      const phalaKey = await getPhalaKey();
      if (!phalaKey) {
        console.log(chalk.yellow("\nNo PHALA API key found"));
        console.log(
          chalk.yellow(`Use 'shade auth set' to store PHALA API key`),
        );
      } else {
        console.log(chalk.green("\nPHALA API key:"));
        console.log(chalk.cyan(phalaKey));
      }
    }

    if (whatToGet === "rpc" || whatToGet === "all") {
      const rpc = await getRpcConfig(network);
      if (!rpc) {
        console.log(chalk.yellow(`\nNo custom RPC configured for ${network}`));
        console.log(
          chalk.yellow(`Use 'shade auth set' to store an RPC URL + key`),
        );
      } else {
        console.log(chalk.green(`\nRPC config for ${network}:`));
        console.log(chalk.cyan(`  URL: ${rpc.url}`));
        console.log(chalk.cyan(`  API key: ${rpc.apiKey ? "(set)" : "(none)"}`));
      }
    }
  } catch (error) {
    // ExitPromptError is handled globally in cli.js
    if (isExitPromptError(error)) {
      process.exit(0);
    }
    console.log(chalk.red(`Error: ${error.message}`));
    process.exit(1);
  }
}

// Clear credentials action
export async function clearCredentials(whatToClearArg, networkArg = null) {
  try {
    const whatToClear = await selectCredentialType(whatToClearArg, "clear");

    let network = null;
    if (
      whatToClear === "near" ||
      whatToClear === "rpc" ||
      whatToClear === "all"
    ) {
      network = await selectNetwork(networkArg, true);
    }

    if (whatToClear === "near" || whatToClear === "all") {
      if (network === "all") {
        // Clear both testnet and mainnet
        const testnetDeleted = await deleteNearCredentials("testnet");
        const mainnetDeleted = await deleteNearCredentials("mainnet");

        if (testnetDeleted) {
          console.log(chalk.green("✓ Master account cleared for testnet"));
        } else {
          console.log(
            chalk.yellow("No master account found for testnet to clear"),
          );
        }

        if (mainnetDeleted) {
          console.log(chalk.green("✓ Master account cleared for mainnet"));
        } else {
          console.log(
            chalk.yellow("No master account found for mainnet to clear"),
          );
        }
      } else {
        const deleted = await deleteNearCredentials(network);
        if (deleted) {
          console.log(chalk.green(`✓ Master account cleared for ${network}`));
        } else {
          console.log(
            chalk.yellow(`No master account found for ${network} to clear`),
          );
        }
      }
    }

    if (whatToClear === "phala" || whatToClear === "all") {
      const deleted = await deletePhalaKey();
      if (deleted) {
        console.log(chalk.green("✓ PHALA API key cleared"));
      } else {
        console.log(chalk.yellow("No PHALA API key found to clear"));
      }
    }

    if (whatToClear === "rpc" || whatToClear === "all") {
      if (network === "all") {
        const testnetDeleted = await deleteRpcConfig("testnet");
        const mainnetDeleted = await deleteRpcConfig("mainnet");
        if (testnetDeleted) {
          console.log(chalk.green("✓ RPC config cleared for testnet"));
        } else {
          console.log(
            chalk.yellow("No RPC config found for testnet to clear"),
          );
        }
        if (mainnetDeleted) {
          console.log(chalk.green("✓ RPC config cleared for mainnet"));
        } else {
          console.log(
            chalk.yellow("No RPC config found for mainnet to clear"),
          );
        }
      } else {
        const deleted = await deleteRpcConfig(network);
        if (deleted) {
          console.log(chalk.green(`✓ RPC config cleared for ${network}`));
        } else {
          console.log(
            chalk.yellow(`No RPC config found for ${network} to clear`),
          );
        }
      }
    }
  } catch (error) {
    // ExitPromptError is handled globally in cli.js
    if (isExitPromptError(error)) {
      process.exit(0);
    }
    console.log(chalk.red(`Error: ${error.message}`));
    process.exit(1);
  }
}
