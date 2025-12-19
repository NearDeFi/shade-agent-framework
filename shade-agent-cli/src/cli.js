#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { deployCommand } from './commands/deploy/index.js';
import { planCommand } from './commands/plan/index.js';
import { authCommand } from './commands/auth/index.js';
import { whitelistCommand } from './commands/whitelist/index.js';
import { versionCheck } from './utils/version-check.js';
import { isExitPromptError, validateAndSelectOption } from './utils/error-handler.js';

// Handle SIGINT (Ctrl+C) gracefully - exit without error
process.on('SIGINT', () => {
    process.exit(0);
});

// Handle errors from inquirer prompts (both async and sync)
const handlePromptError = (error) => {
    if (isExitPromptError(error)) {
        process.exit(0);
    }
};

process.on('unhandledRejection', handlePromptError);
process.on('uncaughtException', handlePromptError);

const program = new Command();

program
    .name('shade')
    .description('CLI tool for deploying and managing Shade agents')
    .version('1.0.2')
    // Configure help to hide the invalid options 
    .configureHelp({
        subcommandTerm: (cmd) => {
            // If command has explicit usage, use it (replacing [invalid] with [command])
            const usage = cmd.usage();
            if (usage !== undefined && usage !== '[options]') {
                return cmd.name() + ' ' + usage.replace(/\[invalid\]/g, '[command]');
            }
            // If command has no options, don't show [options]
            if (cmd.options.length === 0) {
                return cmd.name();
            }
            // Default: commander.js will add [options] automatically
            return cmd.name();
        }
    })
    .addHelpText('after', `
Run 'shade <command>' for more information on a command.
Run 'shade' without arguments to see the interactive menu.
    `);

// Add commands
const deployCmd = deployCommand();
const planCmd = planCommand();
const authCmd = authCommand();
const whitelistCmd = whitelistCommand();

program.addCommand(deployCmd);
program.addCommand(planCmd);
program.addCommand(authCmd);
program.addCommand(whitelistCmd);

// Global version check
program.hook('preAction', async () => {
    await versionCheck();
});

// Check if no command was provided
const args = process.argv.slice(2);
const firstArg = args[0];

const commandOptions = [
    { value: 'deploy', description: 'Deploy the Shade Agent' },
    { value: 'plan', description: 'Show the deployment plan' },
    { value: 'whitelist', description: 'Whitelist an agent account in the agent contract' },
    { value: 'auth', description: 'Manage Shade Agent CLI credentials' }
];

// Validate command if provided, or prompt if not
// Skip validation/prompt if firstArg is a flag (like --help, -v, etc.) - let commander.js handle it
if (args.length === 0 || (firstArg && !firstArg.startsWith('-'))) {
    try {
        // Validate and select command if provided, or prompt if not
        const command = await validateAndSelectOption({
            value: args.length > 0 ? firstArg : null,
            options: commandOptions,
            message: 'What would you like to do?'
        });
        
        // If no command was provided initially, add the selected command to argv
        if (args.length === 0) {
            process.argv.push(command);
        }
        } catch (error) {
            // ExitPromptError is handled globally, but we check here too for the main menu
            if (isExitPromptError(error)) {
                process.exit(0);
            }
            console.log(chalk.red(`Error: ${error.message}`));
            process.exit(1);
        }
}

// Parse normally (will use selected command if selector was shown)
program.parse();
