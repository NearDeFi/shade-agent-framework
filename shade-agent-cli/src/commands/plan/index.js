import { Command } from "commander";
import chalk from "chalk";
import {
  getDeploymentConfig,
  getNearCredentialsOptional,
  getPhalaKeyOptional,
} from "../../utils/config.js";
import { replacePlaceholders, hasPlaceholder } from "../../utils/placeholders.js";
import { createCommandErrorHandler } from "../../utils/error-handler.js";
import { getMeasurements } from "../../utils/measurements.js";
import { getPpids } from "../../utils/ppids.js";

// Format JSON args nicely
function formatArgs(args) {
  return JSON.stringify(args, null, 2);
}

// Wrap text to fit within maxWidth characters
function wrapText(text, maxWidth = 70, indent = 0) {
  const words = text.split(" ");
  const lines = [];
  let currentLine = "";
  const indentStr = " ".repeat(indent);

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    // For wrapped lines (after first line), account for indent
    const effectiveMaxWidth = lines.length > 0 ? maxWidth - indent : maxWidth;
    if (testLine.length <= effectiveMaxWidth) {
      currentLine = testLine;
    } else {
      if (currentLine) {
        lines.push(currentLine);
      }
      // If a single word is longer than maxWidth, just use it as-is
      currentLine = word.length > maxWidth ? word : word;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  // Apply indentation to wrapped lines (skip first line which has bullet)
  return lines.map((line, index) => {
    if (indent > 0 && index > 0) {
      return indentStr + line;
    }
    return line;
  });
}

// Log wrapped text
function logWrapped(text, maxWidth = 70, indent = 0) {
  const lines = wrapText(text, maxWidth, indent);
  lines.forEach((line) => console.log(line));
}

export function planCommand() {
  const cmd = new Command("plan");
  cmd.description("Show the deployment plan");

  // Handle errors for invalid arguments
  cmd.configureOutput(createCommandErrorHandler("plan", { maxArgs: 0 }));

  cmd.action(async () => {
    try {
      // Load deployment config
      const deployment = getDeploymentConfig();

      // Optionally load NEAR credentials to check if they exist and get account ID
      const credentials = await getNearCredentialsOptional(deployment.network);
      const accountId = credentials?.accountId || null;

      // Optionally load PHALA key
      const phalaKey = await getPhalaKeyOptional();

      // Start building the plan output
      console.log("\n" + chalk.cyan.bold("═".repeat(70)));
      console.log(chalk.cyan.bold("🔎 DEPLOYMENT PLAN"));
      console.log(chalk.cyan.bold("═".repeat(70)) + "\n");

      // 1. Docker Image
      console.log(chalk.cyan.bold("🐳 Docker Image"));
      console.log(chalk.gray("─".repeat(70)));
      console.log("");
      if (deployment.environment === "TEE") {
        if (deployment.build_docker_image) {
          const cacheText = deployment.build_docker_image.cache
            ? chalk.yellow("with caching")
            : chalk.yellow("without caching");
          const reproLabel =
            deployment.build_docker_image.reproducible_build === true
              ? chalk.yellow("(reproducible)")
              : chalk.yellow("(non-reproducible)");
          logWrapped(
            `• A docker image for your agent will be built ${reproLabel}, using the ${chalk.yellow(deployment.build_docker_image.dockerfile_path)} file, ${cacheText}, and published to ${chalk.yellow(deployment.build_docker_image.tag)}.`,
            70,
            2,
          );
          console.log("");
          logWrapped(
            `• The docker image hash will be updated in your ${chalk.yellow(deployment.docker_compose_path)} file.`,
            70,
            2,
          );
        } else {
          logWrapped(chalk.gray("• A new docker image won't be built."), 70, 2);
        }
      } else {
        logWrapped(
          chalk.gray(
            "• A docker image won't be built because the environment is local.",
          ),
          70,
          2,
        );
      }
      console.log("");
      console.log("");

      // 2. Contract Deployment
      if (deployment.agent_contract.deploy_custom) {
        console.log(chalk.cyan.bold("📜 Agent Contract Deployment"));
        console.log(chalk.gray("─".repeat(70)));
        console.log("");

        const contractId = deployment.agent_contract.contract_id;
        const network = deployment.network;
        const fundingAmount =
          deployment.agent_contract.deploy_custom.funding_amount;

        let fundingLine = `with a balance of ${chalk.yellow(fundingAmount + " NEAR")}`;
        if (accountId) {
          fundingLine += `, funded from your master account ${chalk.yellow(accountId)}`;
        } else {
          fundingLine += `, funded from your master account`;
        }
        fundingLine += ".";

        logWrapped(
          `• The contract account ${chalk.yellow(contractId)} will be created on ${chalk.yellow(network)} ${fundingLine} If the contract account already exists it will be cleared of its existing contract.`,
          70,
          2,
        );
        console.log("");

        // Deploy from source, WASM, or global hash
        if (deployment.agent_contract.deploy_custom.source_path) {
          const sourcePath =
            deployment.agent_contract.deploy_custom.source_path;
          const contractReproLabel =
            deployment.agent_contract.deploy_custom.reproducible_build === true
              ? chalk.yellow("(reproducible)")
              : chalk.yellow("(non-reproducible)");
          logWrapped(
            `• The agent contract in the ${chalk.yellow(sourcePath)} directory will be compiled ${contractReproLabel} then deployed to ${chalk.yellow(contractId)} on ${chalk.yellow(network)}.`,
            70,
            2,
          );
        } else if (deployment.agent_contract.deploy_custom.wasm_path) {
          const wasmPath = deployment.agent_contract.deploy_custom.wasm_path;
          logWrapped(
            `• The agent contract from the WASM file ${chalk.yellow(wasmPath)} will be deployed to the contract account ${chalk.yellow(contractId)} on ${chalk.yellow(network)}.`,
            70,
            2,
          );
        } else if (deployment.agent_contract.deploy_custom.global_hash) {
          const globalHash =
            deployment.agent_contract.deploy_custom.global_hash;
          logWrapped(
            `• The agent contract will be deployed using the global hash ${chalk.yellow(globalHash)} to the contract account ${chalk.yellow(contractId)} on ${chalk.yellow(network)}.`,
            70,
            2,
          );
        }

        console.log("");

        // Initialization
        if (deployment.agent_contract.deploy_custom.init) {
          const initCfg = deployment.agent_contract.deploy_custom.init;
          const replacements = {};
          replacements["<MASTER_ACCOUNT_ID>"] = accountId;
          replacements["<DEFAULT_MPC_CONTRACT_ID>"] =
            deployment.network === "mainnet"
              ? "v1.signer"
              : "v1.signer-prod.testnet";
          replacements["<REQUIRES_TEE>"] = deployment.environment === "TEE";
          replacements["<7_DAYS>"] = "604800000"; // 7 days in milliseconds (7 * 24 * 60 * 60 * 1000)
          const resolvedArgs = replacePlaceholders(initCfg.args, replacements);

          logWrapped(
            `• The agent contract will be initialized using the '${chalk.yellow(initCfg.method_name)}' method with arguments:`,
            70,
            2,
          );
          // Indent JSON arguments
          const jsonLines = formatArgs(resolvedArgs).split("\n");
          jsonLines.forEach((line) => {
            console.log("  " + chalk.magenta(line));
          });
          if (!accountId) {
            console.log("");
            const noteMsg = `The ${chalk.magenta("<MASTER_ACCOUNT_ID>")} will be replaced once the master account is set.`;
            const lines = wrapText(noteMsg, 70 - 2, 0);
            lines.forEach((line) => console.log("  " + line));
          }
          console.log("");

          // Check if REQUIRES_TEE is in the args
          const argsStr =
            typeof initCfg.args === "string"
              ? initCfg.args
              : JSON.stringify(initCfg.args);
          if (argsStr.includes("<REQUIRES_TEE>")) {
            if (deployment.environment === "TEE") {
              logWrapped(
                `• The contract ${chalk.yellow("requires")} the agent to be running in a TEE.`,
                70,
                2,
              );
            } else {
              logWrapped(
                `• The contract ${chalk.yellow("doesn't require")} the agent to be running in a TEE.`,
                70,
                2,
              );
            }
            console.log("");
          }
        } else {
          logWrapped(
            `• The agent contract ${chalk.yellow("won't be initialized")}.`,
            70,
            2,
          );
          console.log("");
        }

        // Contract locking status
        if (deployment.agent_contract.deploy_custom.delete_key) {
          logWrapped(
            `• The contract account ${chalk.yellow("will be locked")} (access key deleted) after deployment.`,
            70,
            2,
          );
        } else {
          logWrapped(
            `• The contract account ${chalk.yellow("won't be locked")}.`,
            70,
            2,
          );
        }
        console.log("");
      } else {
        console.log(chalk.cyan.bold("📜 Agent Contract Deployment"));
        console.log(chalk.gray("─".repeat(70)));
        console.log("");
        const contractId = deployment.agent_contract.contract_id;
        const network = deployment.network;
        logWrapped(
          `• An existing agent contract deployed at ${chalk.yellow(contractId)} on ${chalk.yellow(network)} will be used. You should check that the agent contract is configured for the desired environment (local or TEE).`,
          70,
          2,
        );
        console.log("");
      }

      console.log("");
      // 3. Approve Measurements
      if (deployment.approve_measurements) {
        console.log(chalk.cyan.bold("✓ Measurements Approval"));
        console.log(chalk.gray("─".repeat(70)));
        console.log("");

        const approveCfg = deployment.approve_measurements;

        logWrapped(
          `• The '${chalk.yellow(approveCfg.method_name)}' method will be called on the agent contract with measurements:`,
          70,
          2,
        );

        // Only resolve the <MEASUREMENTS> placeholder when args actually
        // reference it; otherwise render the args literally and skip the
        // measurement computation entirely.
        const argsHasMeasurements = hasPlaceholder(approveCfg.args, "<MEASUREMENTS>");
        if (deployment.environment === "TEE") {
          console.log("");
          if (argsHasMeasurements && deployment.build_docker_image) {
            const measurementsMsg = `The ${chalk.magenta("<MEASUREMENTS>")} will be replaced by the computed measurements when the docker image is published.`;
            const lines = wrapText(measurementsMsg, 70 - 2, 0);
            lines.forEach((line) => console.log("  " + line));
          } else if (argsHasMeasurements) {
            const replacements = {};
            const measurements = getMeasurements(
              deployment.environment === "TEE",
              deployment.docker_compose_path,
              deployment.deploy_to_phala?.dstack_version,
              deployment.deploy_to_phala?.instance_type,
              {
                publicLogs: deployment.deploy_to_phala?.public_logs,
                publicSysinfo: deployment.deploy_to_phala?.public_sysinfo,
              },
            );
            replacements["<MEASUREMENTS>"] = measurements;
            const args = replacePlaceholders(approveCfg.args, replacements);
            const jsonLines = formatArgs(args).split("\n");
            jsonLines.forEach((line) => {
              console.log("  " + chalk.magenta(line));
            });
          } else {
            // No <MEASUREMENTS> placeholder — render args as-is.
            const jsonLines = formatArgs(approveCfg.args).split("\n");
            jsonLines.forEach((line) => {
              console.log("  " + chalk.magenta(line));
            });
          }
        }
        console.log("");
        console.log("");
      } else {
        console.log(chalk.cyan.bold("✓ Measurements Approval"));
        console.log(chalk.gray("─".repeat(70)));
        console.log("");
        logWrapped(chalk.gray("• The measurements won't be approved."), 70, 2);
        console.log("");
        console.log("");
      }

      // 3b. Approve PPIDs
      if (deployment.approve_ppids) {
        console.log(chalk.cyan.bold("✓ PPIDs Approval"));
        console.log(chalk.gray("─".repeat(70)));
        console.log("");

        const approveCfg = deployment.approve_ppids;

        logWrapped(
          `• The '${chalk.yellow(approveCfg.method_name)}' method will be called on the agent contract with ppids:`,
          70,
          2,
        );

        const ppids = await getPpids(deployment.environment === "TEE");
        const replacements = { "<PPIDS>": ppids };
        const args = replacePlaceholders(approveCfg.args, replacements);

        const jsonLines = formatArgs(args).split("\n");
        jsonLines.forEach((line) => {
          console.log("  " + chalk.magenta(line));
        });
        console.log("");
        console.log("");
      } else {
        console.log(chalk.cyan.bold("✓ PPIDs Approval"));
        console.log(chalk.gray("─".repeat(70)));
        console.log("");
        logWrapped(chalk.gray("• The PPIDs won't be approved."), 70, 2);
        console.log("");
        console.log("");
      }

      // 4. Phala Deployment
      console.log(chalk.cyan.bold("☁️  Phala Cloud Deployment"));
      console.log(chalk.gray("─".repeat(70)));
      console.log("");
      if (deployment.environment === "TEE") {
        if (deployment.deploy_to_phala?.enabled) {
          const dockerStatus = deployment.build_docker_image
            ? "new"
            : "existing";
          logWrapped(
            `• The ${chalk.yellow(dockerStatus)} docker image will be published to Phala Cloud with the name ${chalk.yellow(deployment.deploy_to_phala.app_name)} and the environment variables contained within ${chalk.yellow(deployment.deploy_to_phala.env_file_path)}.`,
            70,
            2,
          );
          logWrapped(
            `• OS image: ${chalk.yellow(`dstack-${deployment.deploy_to_phala.dstack_version}`)}  Instance type: ${chalk.yellow(deployment.deploy_to_phala.instance_type)}`,
            70,
            2,
          );
          logWrapped(
            `• Public logs: ${chalk.yellow(deployment.deploy_to_phala.public_logs ? "enabled" : "disabled")}  Public sysinfo: ${chalk.yellow(deployment.deploy_to_phala.public_sysinfo ? "enabled" : "disabled")}`,
            70,
            2,
          );
        } else {
          logWrapped(
            chalk.gray("• The agent won't be deployed to Phala Cloud."),
            70,
            2,
          );
        }
      } else {
        logWrapped(
          chalk.gray(
            "• The agent won't be deployed to Phala Cloud because the environment is local.",
          ),
          70,
          2,
        );
      }
      console.log("");

      console.log("");
      // 5. Credentials Check
      console.log(chalk.cyan.bold("🔐 Required Credentials Status"));
      console.log(chalk.gray("─".repeat(70)));
      console.log("");

      const missingCredentials = [];

      if (!credentials) {
        missingCredentials.push(`${deployment.network} master account`);
      } else {
        console.log(
          `✓ ${chalk.yellow(deployment.network)} master account configured: ${chalk.yellow(accountId)}`,
        );
      }

      if (
        deployment.environment === "TEE" &&
        deployment.deploy_to_phala?.enabled &&
        !phalaKey
      ) {
        missingCredentials.push("PHALA API key");
      } else if (
        deployment.environment === "TEE" &&
        deployment.deploy_to_phala?.enabled
      ) {
        console.log("✓ PHALA API key: configured");
      }

      if (missingCredentials.length > 0) {
        console.log(chalk.red.dim("⚠️  Missing Credentials:"));
        missingCredentials.forEach((cred) => {
          console.log(chalk.red.dim(`   - ${cred}`));
        });
        console.log("");
        logWrapped(
          chalk.red.dim(
            'Please run "shade auth set" to configure missing credentials.',
          ),
        );
      }

      console.log("");
      console.log("");
    } catch (error) {
      console.log(chalk.red(`Error generating plan: ${error.message}`));
      if (error.stack) {
        console.log(error.stack);
      }
      process.exit(1);
    }
  });

  return cmd;
}
