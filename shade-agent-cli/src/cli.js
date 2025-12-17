#!/usr/bin/env node
import { Command } from 'commander';
import select from '@inquirer/select';
import { deployCommand } from './commands/deploy/index.js';
import { planCommand } from './commands/plan/index.js';
import { authCommand } from './commands/auth/index.js';
import { whitelistCommand } from './commands/whitelist/index.js';
import { versionCheck } from './utils/version-check.js';

// Handle SIGINT (Ctrl+C) gracefully - exit without error
process.on('SIGINT', () => {
    process.exit(0);
});

// Handle unhandled promise rejections from inquirer (e.g., ExitPromptError)
process.on('unhandledRejection', (error) => {
    // Silently exit on SIGINT-related errors from inquirer
    if (error && typeof error === 'object') {
        const errorName = 'name' in error ? error.name : null;
        const errorMessage = 'message' in error && typeof error.message === 'string' ? error.message : null;
        if (errorName === 'ExitPromptError' || (errorMessage && errorMessage.includes('SIGINT'))) {
            process.exit(0);
            return;
        }
    }
    // Let other errors be handled normally
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

if (args.length === 0 || (firstArg && !knownCommands.includes(firstArg) && !firstArg.startsWith('-'))) {
    // Show selector if no command provided or unknown command
    try {
        const command = await select({
            message: 'What would you like to do?',
            choices: [
                { name: 'Deploy - Deploy a Shade agent', value: 'deploy' },
                { name: 'Plan - Show deployment plan (dry-run)', value: 'plan' },
                { name: 'Whitelist - Whitelist an agent account', value: 'whitelist' },
                { name: 'Auth - Manage authentication credentials', value: 'auth' },
            ],
        });
        
        // Add the selected command to argv and continue with normal parsing
        process.argv.push(command);
    } catch (error) {
        // Handle SIGINT gracefully - exit silently
        if (error.name === 'ExitPromptError' || error.message?.includes('SIGINT')) {
            process.exit(0);
        }
        throw error;
    }
}

// Parse normally (will use selected command if selector was shown)
program.parse();
