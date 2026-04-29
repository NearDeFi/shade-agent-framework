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
// "Yes", "no", typo, Ctrl+C — aborts with exit 1. The deploy did not complete,
// and CI / scripting wrappers should treat an aborted destructive redeploy as
// failure (not success) per the CLI's error convention in CLAUDE.md.
//
// Returns the on-chain account state when the account exists (so callers can
// reuse it instead of probing again), null when it doesn't, or undefined when
// the check was skipped (deploy_custom absent, or no contract id / account).
export async function confirmDestructiveRedeployIfAccountExists() {
  const config = await getConfig();
  const deployCustom = config.deployment?.agent_contract?.deploy_custom;
  if (!deployCustom) return undefined;

  const contractAccount = config.contractAccount;
  const contractId = config.deployment.agent_contract.contract_id;
  if (!contractAccount || !contractId) return undefined;

  let state = null;
  try {
    state = await contractAccount.getState();
  } catch (e) {
    if (e.type !== "AccountDoesNotExist") {
      console.log(
        chalk.red(
          `Error: failed to check if contract account ${contractId} exists: ${e.message}`,
        ),
      );
      process.exit(1);
    }
    state = null;
  }
  if (!state) return null;

  const rawText = fs.readFileSync(WARNING_PATH, "utf8");
  const text = rawText.replace("<ACCOUNT_ID>", contractId);

  printBanner(text);

  let answer;
  try {
    answer = await input({ message: 'Type "yes" to confirm:' });
  } catch (_e) {
    // ExitPromptError (Ctrl+C) or non-TTY EOF — treat as cancel.
    console.log(chalk.red("\nAborted: type 'yes' to proceed."));
    process.exit(1);
  }

  if (answer.trim() !== "yes") {
    console.log(chalk.red("Aborted: type 'yes' to proceed."));
    process.exit(1);
  }

  return state;
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
