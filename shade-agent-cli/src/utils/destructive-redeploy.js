import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import input from "@inquirer/input";
import { getConfig } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WARNING_PATH = path.join(__dirname, "destructive-redeploy-warning.txt");

// If deploy_custom is set in deployment.yaml AND the contract account already
// exists on-chain, we are about to delete it (along with all its state and
// assets) and recreate it from scratch. Hard-confirm with the operator before
// any other deploy step runs (no docker build, no measurements, no Phala API).
//
// Acceptance: trim(answer) === "yes" exactly. Anything else — Enter, "y",
// "Yes", "no", typo, Ctrl+C — aborts with exit 0 (cancel is a deliberate
// choice, not an error; exit 1 would trip CI alarms).
export async function confirmDestructiveRedeployIfAccountExists() {
  const config = await getConfig();
  const deployCustom = config.deployment?.agent_contract?.deploy_custom;
  if (!deployCustom) return;

  const contractAccount = config.contractAccount;
  const contractId = config.deployment.agent_contract.contract_id;
  if (!contractAccount || !contractId) return;

  let exists = false;
  try {
    await contractAccount.getState();
    exists = true;
  } catch (e) {
    if (e.type !== "AccountDoesNotExist") {
      console.log(
        chalk.red(
          `Error: failed to check if contract account ${contractId} exists: ${e.message}`,
        ),
      );
      process.exit(1);
    }
  }
  if (!exists) return;

  const rawText = fs.readFileSync(WARNING_PATH, "utf8");
  const text = rawText.replace("<ACCOUNT_ID>", contractId);

  printBanner(text);

  let answer;
  try {
    answer = await input({ message: 'Type "yes" to confirm:' });
  } catch (_e) {
    // ExitPromptError (Ctrl+C) or non-TTY EOF — treat as cancel.
    console.log(chalk.red("\nAborted: type 'yes' to proceed."));
    process.exit(0);
  }

  if (answer.trim() !== "yes") {
    console.log(chalk.red("Aborted: type 'yes' to proceed."));
    process.exit(0);
  }
}

function printBanner(text) {
  // The .txt file ends with a "Type 'yes' to confirm:" line; @inquirer/input
  // renders its own prompt for that, so strip the trailing instruction lines
  // from the banner body to avoid duplication.
  const lines = text.split("\n").map((l) => l.trimEnd());
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length && lines[lines.length - 1].startsWith('Type "yes"')) {
    lines.pop();
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
  }

  const width = Math.max(...lines.map((l) => l.length));
  const horizontal = "─".repeat(width + 4);

  console.log("");
  console.log(chalk.red.bold(`┌${horizontal}┐`));
  console.log(chalk.red.bold(`│${" ".repeat(width + 4)}│`));
  for (const line of lines) {
    const padded = line.padEnd(width);
    const inner = line.startsWith("DESTRUCTIVE ACTION")
      ? chalk.bgRed.white.bold(`  ${padded}  `)
      : chalk.red(`  ${padded}  `);
    console.log(chalk.red.bold("│") + inner + chalk.red.bold("│"));
  }
  console.log(chalk.red.bold(`│${" ".repeat(width + 4)}│`));
  console.log(chalk.red.bold(`└${horizontal}┘`));
  console.log("");
}
