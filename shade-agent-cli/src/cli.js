#!/usr/bin/env node
import { Command } from 'commander';
import select from '@inquirer/select';
import chalk from 'chalk';
import { deployCommand } from './commands/deploy/index.js';
import { planCommand } from './commands/plan/index.js';
import { authCommand } from './commands/auth/index.js';
import { whitelistCommand } from './commands/whitelist/index.js';
import { versionCheck } from './utils/version-check.js';
import { isExitPromptError } from './utils/error-handler.js';

// Handle SIGINT (Ctrl+C) gracefully - exit without error
process.on('SIGINT', () => {
    process.exit(0);
});

// Handle unhandled promise rejections from inquirer (e.g., ExitPromptError)
process.on('unhandledRejection', (error) => {
    // Silently exit on SIGINT-related errors from inquirer
    if (isExitPromptError(error)) {
        process.exit(0);
        return;
    }
    // Let other errors be handled normally
});

// Handle uncaught exceptions from inquirer prompts
process.on('uncaughtException', (error) => {
    // Silently exit on SIGINT-related errors from inquirer
    if (isExitPromptError(error)) {
        process.exit(0);
        return;
    }
    // For other errors, let the default behavior happen (Node will exit with error code)
    // We don't re-throw because that would cause issues
});

const program = new Command();

program
    .name('shade')
    .description('CLI tool for deploying and managing Shade agents')
    .version('1.0.2');

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
const knownCommands = ['auth', 'deploy', 'plan', 'whitelist'];
const firstArg = args[0];

// If a command is provided, validate it first
if (firstArg && !firstArg.startsWith('-')) {
    if (!knownCommands.includes(firstArg)) {
        console.error(chalk.red(`Error: Unknown command '${firstArg}'.`));
        console.error(chalk.yellow('\nAvailable commands:'));
        knownCommands.forEach(cmd => {
            const descriptions = {
                'deploy': 'Deploy a Shade agent',
                'plan': 'Show deployment plan (dry-run)',
                'whitelist': 'Whitelist an agent account',
                'auth': 'Manage authentication credentials'
            };
            console.error(`  ${chalk.yellow(cmd)} - ${chalk.blue(descriptions[cmd] || '')}`);
        });
        console.error(chalk.yellow('\nRun \'shade\' without arguments to see the interactive menu.'));
        process.exit(1);
    }
}

if (args.length === 0) {
    // Show selector if no command provided
    try {
        const command = await select({
            message: 'What would you like to do?',
            choices: [
                { name: `${chalk.yellow('deploy')} - ${chalk.blue('Deploy a Shade agent')}`, value: 'deploy' },
                { name: `${chalk.yellow('plan')} - ${chalk.blue('Show deployment plan (dry-run)')}`, value: 'plan' },
                { name: `${chalk.yellow('whitelist')} - ${chalk.blue('Whitelist an agent account')}`, value: 'whitelist' },
                { name: `${chalk.yellow('auth')} - ${chalk.blue('Manage authentication credentials')}`, value: 'auth' },
            ],
        });
        
        // Add the selected command to argv and continue with normal parsing
        process.argv.push(command);
    } catch (error) {
        // ExitPromptError is handled globally, but we check here too for the main menu
        if (isExitPromptError(error)) {
            process.exit(0);
        }
        throw error;
    }
}

// Parse normally (will use selected command if selector was shown)
program.parse();
