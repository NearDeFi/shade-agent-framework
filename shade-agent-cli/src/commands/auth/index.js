import { Command } from 'commander';
import chalk from 'chalk';
import { createCommandErrorHandler, validateAndSelectOption, isExitPromptError } from '../../utils/error-handler.js';
import { setCredentials, getCredentials, clearCredentials } from './actions.js';

export function authCommand() {
    const cmd = new Command('auth');
    cmd.description('Manage Shade Agent CLI credentials');
    
    // Handle errors for invalid arguments or unknown subcommands
    const subcommands = [
        { value: 'set', description: 'Set Shade Agent CLI credentials' },
        { value: 'get', description: 'Get Shade Agent CLI credentials' },
        { value: 'clear', description: 'Clear Shade Agent CLI credentials' }
    ];
    cmd.configureOutput(createCommandErrorHandler('auth', {
        validOptions: subcommands,
        itemType: 'subcommand'
    }));
    
    // Set identifiers correctly for help
    cmd.argument('[invalid]');
    cmd.usage('[command]');
    
    // auth set command
    const setCmd = new Command('set');
    setCmd.description('Set Shade Agent CLI credentials');
    setCmd.configureOutput(createCommandErrorHandler('set', { maxArgs: 3, parentCommand: 'auth' }));
    setCmd.argument('[type]', 'Type of credentials to set: all, near, or phala')
        .argument('[network]', 'Network: testnet or mainnet (only for near/all)')
        .argument('[credentialOption]', 'Credential option: create-new or existing-account (only for testnet)')
        .action(async (type, network, credentialOption) => {
            await setCredentials(type, network, credentialOption);
        });
    
    // auth get command
    const getCmd = new Command('get');
    getCmd.description('Get Shade Agent CLI credentials');
    getCmd.configureOutput(createCommandErrorHandler('get', { maxArgs: 2, parentCommand: 'auth' }));
    getCmd.argument('[type]', 'Type of credentials to get: all, near, or phala')
        .argument('[network]', 'Network: testnet or mainnet (only for near/all)')
        .action(async (type, network) => {
            await getCredentials(type, network);
        });
    
    // auth clear command
    const clearCmd = new Command('clear');
    clearCmd.description('Clear Shade Agent CLI credentials');
    clearCmd.configureOutput(createCommandErrorHandler('clear', { maxArgs: 2, parentCommand: 'auth' }));
    clearCmd.argument('[type]', 'Type of credentials to clear: all, near, or phala')
        .argument('[network]', 'Network: all, testnet, or mainnet (only for near/all)')
        .action(async (type, network) => {
            await clearCredentials(type, network);
        });
    
    cmd.addCommand(setCmd);
    cmd.addCommand(getCmd);
    cmd.addCommand(clearCmd);
    
    // Default action: show selector if no subcommand provided
    cmd.action(async (invalidArg) => {
        const subcommandOptions = [
            { value: 'set', description: 'Set Shade Agent CLI credentials' },
            { value: 'get', description: 'Get Shade Agent CLI credentials' },
            { value: 'clear', description: 'Clear Shade Agent CLI credentials' }
        ];
        
        try {
            const subcommand = await validateAndSelectOption({
                value: invalidArg,
                options: subcommandOptions,
                message: 'Would you like to set, get, or clear credentials?',
                parentCommand: 'auth',
                itemType: 'subcommand'
            });
            
            // Execute the selected subcommand action
            if (subcommand === 'get') {
                await getCredentials();
            } else if (subcommand === 'set') {
                await setCredentials();
            } else if (subcommand === 'clear') {
                await clearCredentials();
            }
        } catch (error) {
            // ExitPromptError is handled globally in cli.js
            if (isExitPromptError(error)) {
                process.exit(0);
            }
            console.log(chalk.red(`Error: ${error.message}`));
            process.exit(1);
        }
    });
    
    return cmd;
}
