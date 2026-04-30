import { Command } from "commander";
import chalk from "chalk";
import { dockerImage } from "./docker.js";
import {
  createAccount,
  deployCustomContractFromSource,
  deployCustomContractFromWasm,
  deployCustomContractFromGlobalHash,
  initContract,
  approveMeasurements,
  approvePpids,
  deleteContractKey,
} from "./near.js";
import { deployPhalaWorkflow } from "./phala.js";
import { getConfig } from "../../utils/config.js";
import { createCommandErrorHandler } from "../../utils/error-handler.js";
import { confirmDestructiveRedeployIfAccountExists } from "../../utils/destructive-redeploy.js";

export function deployCommand() {
  const cmd = new Command("deploy");
  cmd.description("Deploy the Shade Agent");

  // Handle errors for invalid arguments
  cmd.configureOutput(createCommandErrorHandler("deploy", { maxArgs: 0 }));

  cmd.action(async () => {
    try {
      // Load config at the start of deploy
      const config = await getConfig();

      // Hard confirmation BEFORE any other work (docker build, measurements,
      // Phala provisioning, account delete). If deploy_custom is true and the
      // contract account already exists, the user must type "yes" to allow
      // the irreversible state + asset wipe. The on-chain state is fetched
      // here so createAccount() doesn't have to probe again.
      const contractAccountState =
        await confirmDestructiveRedeployIfAccountExists();

      if (
        config.deployment.environment === "TEE" &&
        config.deployment.build_docker_image
      ) {
        await dockerImage();
      }
      if (config.deployment.agent_contract.deploy_custom) {
        await createAccount(contractAccountState);

        if (config.deployment.agent_contract.deploy_custom.source_path) {
          await deployCustomContractFromSource();
        }

        if (config.deployment.agent_contract.deploy_custom.wasm_path) {
          await deployCustomContractFromWasm();
        }

        if (config.deployment.agent_contract.deploy_custom.global_hash) {
          await deployCustomContractFromGlobalHash();
        }

        if (config.deployment.agent_contract.deploy_custom.init) {
          await initContract();
        }

        if (config.deployment.agent_contract.deploy_custom.delete_key) {
          await deleteContractKey();
        }
      }

      if (config.deployment.approve_measurements) {
        await approveMeasurements();
      }

      if (config.deployment.approve_ppids) {
        await approvePpids();
      }

      if (
        config.deployment.deploy_to_phala &&
        config.deployment.environment === "TEE"
      ) {
        await deployPhalaWorkflow();
      }

      console.log(chalk.green("\n✓ Deployment completed successfully!"));
    } catch (error) {
      console.log(chalk.red(`Error during deployment: ${error.message}`));
      if (error.stack) {
        console.log(error.stack);
      }
      process.exit(1);
    }
  });

  return cmd;
}
