import { Command } from 'commander';
import select from '@inquirer/select';
import input from '@inquirer/input';
import { KeyPair } from '@near-js/crypto';
import { generate as randomWords } from 'random-words';
import { getCredentials, setCredentials, getPhalaKey, setPhalaKey, deleteCredentials, deletePhalaKey } from '../../utils/keystore.js';
import { isExitPromptError, showInvalidArgumentError } from '../../utils/error-handler.js';
import chalk from 'chalk';

// Generate a random account ID using two random words
function generateRandomAccountId() {
    return randomWords({ exactly: 2, join: '-' });
}

// Helper function to create account via faucet service
async function createAccountViaFaucet(accountId, publicKey, showTransactionDetails = true) {
    const faucetUrl = 'https://helper.nearprotocol.com/account';
    
    const data = {
        newAccountId: accountId,
        newAccountPublicKey: publicKey,
    };
    
    try {
        console.log(chalk.blue(`\nCreating account via faucet service...`));
        const response = await fetch(faucetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Faucet service failed with status ${response.status}: ${errorText}`);
        }
        
        const result = await response.json();
        
        // Debug: log the response structure (can be removed later)
        if (process.env.DEBUG) {
            console.log(chalk.gray(`\nDebug - Faucet response: ${JSON.stringify(result, null, 2)}`));
        }
        
        // Parse the response similar to near-cli-rs
        // The response is an RpcTransactionResponse with final_execution_outcome
        if (!result.final_execution_outcome) {
            // If no final_execution_outcome, check if the response itself is the outcome
            if (result.status && result.transaction_outcome) {
                // The response might be the outcome directly
                const outcome = result;
                return handleTransactionOutcome(outcome, accountId, showTransactionDetails);
            }
            throw new Error('Faucet service did not return a valid transaction response');
        }
        
        const outcome = result.final_execution_outcome;
        
        return handleTransactionOutcome(outcome, accountId, showTransactionDetails);
    } catch (error) {
        console.error(chalk.red(`\nError creating account via faucet: ${error.message}`));
        throw error;
    }
}

// Helper function to handle transaction outcome
function handleTransactionOutcome(outcome, accountId, showTransactionDetails = true) {
    // Get transaction ID from transaction_outcome (at the top level of outcome)
    const txOutcome = outcome.transaction_outcome;
    if (!txOutcome || !txOutcome.id) {
        throw new Error('Faucet service did not return a transaction ID');
    }
    
    const txId = txOutcome.id;
    
    // Check execution status
    // The status can be SuccessValue, Failure, NotStarted, or Started
    if (outcome.status) {
        // Handle SuccessValue - check if it's bytes "false"
        if (outcome.status.SuccessValue !== undefined) {
            const successValue = outcome.status.SuccessValue;
            // SuccessValue can be base64 encoded bytes or a string
            // In Rust, it checks if value == b"false" (bytes)
            let decodedValue = successValue;
            
            // Try to decode if it's base64
            if (typeof successValue === 'string') {
                try {
                    // Check if it's base64 encoded
                    const decoded = Buffer.from(successValue, 'base64').toString('utf8');
                    decodedValue = decoded;
                } catch (e) {
                    // Not base64, use as-is
                    decodedValue = successValue;
                }
            }
            
            // Check if the value is "false" (as bytes or string)
            if (decodedValue === false || decodedValue === 'false' || decodedValue === Buffer.from('false').toString('base64')) {
                console.log(chalk.yellow(`\nWarning: Account creation may have failed (faucet returned false)`));
                if (showTransactionDetails) {
                    console.log(chalk.cyan(`  Transaction ID: ${txId}`));
                    console.log(chalk.cyan(`  View transaction: https://explorer.testnet.near.org/transactions/${txId}`));
                }
                throw new Error('Account creation failed - faucet service returned false');
            }
            
            // Success!
            console.log(chalk.green(`✓ Account created successfully!`));
            if (showTransactionDetails) {
                console.log(chalk.cyan(`  Transaction ID: ${txId}`));
                console.log(chalk.cyan(`  View transaction: https://explorer.testnet.near.org/transactions/${txId}`));
            }
            return true;
        }
        
        // Handle Failure
        if (outcome.status.Failure) {
            const failure = outcome.status.Failure;
            console.log(chalk.yellow(`\nWarning: Account creation failed`));
            if (showTransactionDetails) {
                console.log(chalk.cyan(`  Transaction ID: ${txId}`));
                console.log(chalk.cyan(`  View transaction: https://explorer.testnet.near.org/transactions/${txId}`));
            }
            throw new Error(`Account creation failed: ${JSON.stringify(failure)}`);
        }
        
        // Handle other statuses (NotStarted, Started - should be unreachable)
        if (outcome.status.NotStarted || outcome.status.Started) {
            throw new Error('Transaction status is NotStarted or Started - this should not happen');
        }
    }
    
    // If we get here and have a transaction ID, assume success (account was created)
    // This handles cases where the status might not be in the expected format
    console.log(chalk.green(`✓ Account created successfully!`));
    if (showTransactionDetails) {
        console.log(chalk.cyan(`  Transaction ID: ${txId}`));
        console.log(chalk.cyan(`  View transaction: https://explorer.testnet.near.org/transactions/${txId}`));
    }
    return true;
}

// Helper function to prompt for credentials or create new account for testnet
async function promptAndStoreCredentials(network, credentialOptionArg = null) {
    let accountId, privateKey;
    
    // For testnet, offer create-new option
    if (network === 'testnet') {
        let credentialOption = credentialOptionArg;
        
        // Validate if provided
        if (credentialOption && !['create-new', 'existing-account'].includes(credentialOption)) {
            console.error(chalk.red(`Error: Invalid credential option '${credentialOptionArg}'. Must be one of: create-new, existing-account`));
            console.error(chalk.yellow('\nAvailable options:'));
            console.error(`  ${chalk.yellow('create-new')} - ${chalk.blue('Generate a random new account')}`);
            console.error(`  ${chalk.yellow('existing-account')} - ${chalk.blue('Enter credentials for an existing account')}`);
            process.exit(1);
        }
        
        // Prompt if not provided
        if (!credentialOption) {
            credentialOption = await select({
            message: 'How would you like to set up credentials?',
            choices: [
                    { name: `${chalk.yellow('create-new')} - ${chalk.blue('Generate a random new account')}`, value: 'create-new' },
                    { name: `${chalk.yellow('existing-account')} - ${chalk.blue('Enter credentials for an existing account')}`, value: 'existing-account' },
            ],
        });
        }
        
        if (credentialOption === 'create-new') {
            // Generate account ID using two random words
            accountId = `${generateRandomAccountId()}.testnet`;
            
            // Generate a new keypair
            const keyPair = KeyPair.fromRandom("ed25519");
            // Get the private key in the format "ed25519:..."
            privateKey = keyPair.toString();
            const publicKey = keyPair.getPublicKey().toString();
            
            // Create account via faucet service - must succeed before storing credentials
            await createAccountViaFaucet(accountId, publicKey, false);
        } else {
            accountId = await input({
                message: 'Enter account ID:',
                validate: (value) => {
                    if (!value || value.trim().length === 0) {
                        return 'Account ID is required';
                    }
                    return true;
                },
            });
            
            privateKey = await input({
                message: 'Enter private key:',
                validate: (value) => {
                    if (!value || value.trim().length === 0) {
                        return 'Private key is required';
                    }
                    // Check if it's in the format ed25519:... or secp256k1:...
                    if (!value.startsWith('ed25519:') && !value.startsWith('secp256k1:')) {
                        return 'Private key should start with "ed25519:" or "secp256k1:"';
                    }
                    return true;
                },
            });
        }
    } else {
        // For mainnet, always use existing-account (no account creation via faucet)
        accountId = await input({
            message: 'Enter account ID:',
            validate: (value) => {
                if (!value || value.trim().length === 0) {
                    return 'Account ID is required';
                }
                return true;
            },
        });
        
        privateKey = await input({
            message: 'Enter private key:',
            validate: (value) => {
                if (!value || value.trim().length === 0) {
                    return 'Private key is required';
                }
                // Check if it's in the format ed25519:... or secp256k1:...
                if (!value.startsWith('ed25519:') && !value.startsWith('secp256k1:')) {
                    return 'Private key should start with "ed25519:" or "secp256k1:"';
                }
                return true;
            },
        });
    }
    
    await setCredentials(network, accountId.trim(), privateKey.trim());
    console.log(chalk.green(`✓ Master account stored for ${network}`));
    console.log(chalk.cyan(`  Account ID: ${accountId.trim()}`));
    console.log(chalk.cyan(`  Private Key: ${privateKey.trim()}`));
}

export function authCommand() {
    const cmd = new Command('auth');
    cmd.description('Set up master account and authentication');
    
    // Handle errors for invalid arguments or unknown subcommands
    cmd.configureOutput({
        writeErr: (str) => {
            // Check if it's a "too many arguments" or "unknown command" error
            if (str.includes('too many arguments') || str.includes('unknown command')) {
                const args = process.argv.slice(2);
                const providedArg = args[1]; // The argument after 'auth'
                
                console.error(chalk.red(`Error: '${providedArg}' is not a valid subcommand for 'auth'.`));
                console.error(chalk.yellow('\nAvailable subcommands:'));
                console.error(`  ${chalk.yellow('set')} - ${chalk.blue('Set Shade Agent CLI credentials')}`);
                console.error(`  ${chalk.yellow('get')} - ${chalk.blue('Get Shade Agent CLI credentials')}`);
                console.error(`  ${chalk.yellow('clear')} - ${chalk.blue('Clear Shade Agent CLI credentials')}`);
                process.exit(1);
            } else {
                process.stderr.write(str);
            }
        }
    });
    
    // Accept an optional argument to catch invalid subcommands
    cmd.argument('[invalid]', 'Invalid argument handler');
    
    // Define the set action function
    const setAction = async (whatToSetArg, networkArg = null, credentialOptionArg = null) => {
        try {
            // Validate argument if provided (check user-facing values first)
            if (whatToSetArg && !['all', 'near', 'phala'].includes(whatToSetArg)) {
                showInvalidArgumentError(whatToSetArg, 'option', [
                    { value: 'all', description: 'Set both NEAR and PHALA credentials' },
                    { value: 'near', description: 'Set NEAR master account only' },
                    { value: 'phala', description: 'Set PHALA API key only' },
                ]);
            }
            
            // Normalize arguments: "near" -> "network" (for internal use)
            let whatToSet = whatToSetArg;
            if (whatToSet === 'near') {
                whatToSet = 'network';
            }
            
            // Ask what to set if not provided
            if (!whatToSet) {
                whatToSet = await select({
                message: 'What would you like to set?',
                    choices: [
                        { name: `${chalk.yellow('all')} - ${chalk.blue('Set both NEAR and PHALA credentials')}`, value: 'all' },
                        { name: `${chalk.yellow('near')} - ${chalk.blue('Set NEAR master account only')}`, value: 'network' },
                        { name: `${chalk.yellow('phala')} - ${chalk.blue('Set PHALA API key only')}`, value: 'phala' },
                    ],
                });
            }

            if (whatToSet === 'network' || whatToSet === 'all') {
                let network = networkArg;
                
                // Validate network if provided
                if (network && !['testnet', 'mainnet'].includes(network)) {
                    console.error(chalk.red(`Error: Invalid network '${networkArg}'. Must be one of: testnet, mainnet`));
                    console.error(chalk.yellow('\nAvailable options:'));
                    console.error(`  ${chalk.yellow('testnet')} - ${chalk.blue('NEAR Testnet')}`);
                    console.error(`  ${chalk.yellow('mainnet')} - ${chalk.blue('NEAR Mainnet')}`);
                    process.exit(1);
                }
                
                // Prompt if not provided
                if (!network) {
                    network = await select({
                        message: 'Select network:',
                        choices: [
                            { name: `${chalk.yellow('testnet')} - ${chalk.blue('NEAR Testnet')}`, value: 'testnet' },
                            { name: `${chalk.yellow('mainnet')} - ${chalk.blue('NEAR Mainnet')}`, value: 'mainnet' },
                        ],
                    });
                }

                // Prompt for credentials (will replace if they exist)
                await promptAndStoreCredentials(network, credentialOptionArg);
            }

            if (whatToSet === 'phala' || whatToSet === 'all') {
                // Prompt for PHALA API key (will replace if it exists)
                const phalaKey = await input({
                    message: 'Enter PHALA API key:',
                    validate: (value) => {
                        if (!value || value.trim().length === 0) {
                            return 'PHALA API key is required';
                        }
                        return true;
                    },
                });
                
                const trimmedKey = phalaKey.trim();
                await setPhalaKey(trimmedKey);
                console.log(chalk.green('✓ PHALA API key stored'));
                console.log(chalk.green('\nStored PHALA API key:'));
                console.log(chalk.cyan(`  ${trimmedKey}`));
            }
        } catch (error) {
            // ExitPromptError is handled globally in cli.js
            if (isExitPromptError(error)) {
                process.exit(0);
            }
            if (error.message && error.message.includes('libsecret')) {
                console.error(chalk.red('Error: libsecret is required on Linux.'));
                console.error(chalk.yellow('Please install it:'));
                console.error(chalk.yellow('  Debian/Ubuntu: sudo apt-get install libsecret-1-dev'));
                console.error(chalk.yellow('  Red Hat-based: sudo yum install libsecret-devel'));
                console.error(chalk.yellow('  Arch Linux: sudo pacman -S libsecret'));
            } else {
                console.error(chalk.red(`Error: ${error.message}`));
            }
            process.exit(1);
        }
    };
    
    // Define the get action function
    const getAction = async (whatToGetArg, networkArg = null) => {
        try {
            // Validate argument if provided (check user-facing values first)
            if (whatToGetArg && !['all', 'near', 'phala'].includes(whatToGetArg)) {
                showInvalidArgumentError(whatToGetArg, 'option', [
                    { value: 'all', description: 'Get both NEAR and PHALA credentials' },
                    { value: 'near', description: 'Get NEAR master account only' },
                    { value: 'phala', description: 'Get PHALA API key only' },
                ]);
            }
            
            // Normalize arguments: "near" -> "network" (for internal use)
            let whatToGet = whatToGetArg;
            if (whatToGet === 'near') {
                whatToGet = 'network';
            }
            
            // Ask what to get if not provided
            if (!whatToGet) {
                whatToGet = await select({
                message: 'What would you like to view?',
                    choices: [
                        { name: `${chalk.yellow('all')} - ${chalk.blue('Get both NEAR and PHALA credentials')}`, value: 'all' },
                        { name: `${chalk.yellow('near')} - ${chalk.blue('Get NEAR master account only')}`, value: 'network' },
                        { name: `${chalk.yellow('phala')} - ${chalk.blue('Get PHALA API key only')}`, value: 'phala' },
                    ],
                });
            }

            if (whatToGet === 'network' || whatToGet === 'all') {
                let network = networkArg;
                
                // Validate network if provided
                if (network && !['testnet', 'mainnet'].includes(network)) {
                    console.error(chalk.red(`Error: Invalid network '${networkArg}'. Must be one of: testnet, mainnet`));
                    console.error(chalk.yellow('\nAvailable options:'));
                    console.error(`  ${chalk.yellow('testnet')} - ${chalk.blue('NEAR Testnet')}`);
                    console.error(`  ${chalk.yellow('mainnet')} - ${chalk.blue('NEAR Mainnet')}`);
                    process.exit(1);
                }
                
                // Prompt if not provided
                if (!network) {
                    network = await select({
                        message: 'Select network:',
                        choices: [
                            { name: `${chalk.yellow('testnet')} - ${chalk.blue('NEAR Testnet')}`, value: 'testnet' },
                            { name: `${chalk.yellow('mainnet')} - ${chalk.blue('NEAR Mainnet')}`, value: 'mainnet' },
                        ],
                    });
                }
                
                const credentials = await getCredentials(network);
                
                if (!credentials) {
                    console.log(chalk.yellow(`No master account found for ${network}`));
                    console.log(chalk.yellow(`Use 'shade auth set' to set master account`));
                } else {
                    console.log(chalk.green(`\nMaster account for ${network}:`));
                    console.log(chalk.cyan(`Account ID: ${credentials.accountId}`));
                    console.log(chalk.cyan(`Private Key: ${credentials.privateKey}`));
                }
            }

            if (whatToGet === 'phala' || whatToGet === 'all') {
                const phalaKey = await getPhalaKey();
                if (!phalaKey) {
                    console.log(chalk.yellow('\nNo PHALA API key found'));
                    console.log(chalk.yellow(`Use 'shade auth set' to store PHALA API key`));
                } else {
                    console.log(chalk.green('\nPHALA API key:'));
                    console.log(chalk.cyan(phalaKey));
                }
            }
        } catch (error) {
            // ExitPromptError is handled globally in cli.js
            if (isExitPromptError(error)) {
                process.exit(0);
            }
            if (error.message && error.message.includes('libsecret')) {
                console.error(chalk.red('Error: libsecret is required on Linux.'));
                console.error(chalk.yellow('Please install it:'));
                console.error(chalk.yellow('  Debian/Ubuntu: sudo apt-get install libsecret-1-dev'));
                console.error(chalk.yellow('  Red Hat-based: sudo yum install libsecret-devel'));
                console.error(chalk.yellow('  Arch Linux: sudo pacman -S libsecret'));
            } else {
                console.error(chalk.red(`Error: ${error.message}`));
            }
            process.exit(1);
        }
    };
    
    // Define the clear action function
    const clearAction = async (whatToClearArg, networkArg = null) => {
        try {
            // Validate argument if provided (check user-facing values first)
            if (whatToClearArg && !['all', 'near', 'phala'].includes(whatToClearArg)) {
                showInvalidArgumentError(whatToClearArg, 'option', [
                    { value: 'all', description: 'Clear both NEAR and PHALA credentials' },
                    { value: 'near', description: 'Clear NEAR master account only' },
                    { value: 'phala', description: 'Clear PHALA API key only' },
                ]);
            }
            
            // Normalize arguments: "near" -> "network" (for internal use)
            let whatToClear = whatToClearArg;
            if (whatToClear === 'near') {
                whatToClear = 'network';
            }
            
            // Ask what to clear if not provided
            if (!whatToClear) {
                whatToClear = await select({
                    message: 'What would you like to clear?',
                    choices: [
                        { name: `${chalk.yellow('all')} - ${chalk.blue('Clear both NEAR and PHALA credentials')}`, value: 'all' },
                        { name: `${chalk.yellow('near')} - ${chalk.blue('Clear NEAR master account only')}`, value: 'network' },
                        { name: `${chalk.yellow('phala')} - ${chalk.blue('Clear PHALA API key only')}`, value: 'phala' },
                    ],
                });
            }

            if (whatToClear === 'network' || whatToClear === 'all') {
                let network = networkArg;
                
                // Validate network if provided
                if (network && !['all', 'testnet', 'mainnet'].includes(network)) {
                    console.error(chalk.red(`Error: Invalid network '${networkArg}'. Must be one of: all, testnet, mainnet`));
                    console.error(chalk.yellow('\nAvailable options:'));
                    console.error(`  ${chalk.yellow('all')} - ${chalk.blue('Clear both networks')}`);
                    console.error(`  ${chalk.yellow('testnet')} - ${chalk.blue('NEAR Testnet')}`);
                    console.error(`  ${chalk.yellow('mainnet')} - ${chalk.blue('NEAR Mainnet')}`);
                    process.exit(1);
                }
                
                // Prompt if not provided
                if (!network) {
                    network = await select({
                        message: 'Select network:',
                        choices: [
                            { name: `${chalk.yellow('all')} - ${chalk.blue('Clear both networks')}`, value: 'all' },
                            { name: `${chalk.yellow('testnet')} - ${chalk.blue('NEAR Testnet')}`, value: 'testnet' },
                            { name: `${chalk.yellow('mainnet')} - ${chalk.blue('NEAR Mainnet')}`, value: 'mainnet' },
                        ],
                    });
                }

                if (network === 'all') {
                    // Clear both testnet and mainnet
                    const testnetDeleted = await deleteCredentials('testnet');
                    const mainnetDeleted = await deleteCredentials('mainnet');
                    
                    if (testnetDeleted) {
                        console.log(chalk.green('✓ Master account cleared for testnet'));
                    } else {
                        console.log(chalk.yellow('No master account found for testnet to clear'));
                    }
                    
                    if (mainnetDeleted) {
                        console.log(chalk.green('✓ Master account cleared for mainnet'));
                    } else {
                        console.log(chalk.yellow('No master account found for mainnet to clear'));
                    }
                } else {
                    const deleted = await deleteCredentials(network);
                    if (deleted) {
                        console.log(chalk.green(`✓ Master account cleared for ${network}`));
                    } else {
                        console.log(chalk.yellow(`No master account found for ${network} to clear`));
                    }
                }
            }

            if (whatToClear === 'phala' || whatToClear === 'all') {
                const deleted = await deletePhalaKey();
                if (deleted) {
                    console.log(chalk.green('✓ PHALA API key cleared'));
                } else {
                    console.log(chalk.yellow('No PHALA API key found to clear'));
                }
            }
        } catch (error) {
            // ExitPromptError is handled globally in cli.js
            if (isExitPromptError(error)) {
                process.exit(0);
            }
            if (error.message && error.message.includes('libsecret')) {
                console.error(chalk.red('Error: libsecret is required on Linux.'));
                console.error(chalk.yellow('Please install it:'));
                console.error(chalk.yellow('  Debian/Ubuntu: sudo apt-get install libsecret-1-dev'));
                console.error(chalk.yellow('  Red Hat-based: sudo yum install libsecret-devel'));
                console.error(chalk.yellow('  Arch Linux: sudo pacman -S libsecret'));
            } else {
                console.error(chalk.red(`Error: ${error.message}`));
            }
            process.exit(1);
        }
    };
    
    // auth set command
    const setCmd = new Command('set');
    setCmd.description('Set Shade Agent CLI credentials');
    setCmd.configureOutput({
        writeErr: (str) => {
            if (str.includes('too many arguments')) {
                // Get the last valid argument from the command (set accepts max 3 args)
                const args = process.argv.slice(2);
                const authIndex = args.indexOf('auth');
                const setIndex = args.indexOf('set', authIndex);
                const providedArgs = args.slice(setIndex + 1);
                // Last valid argument is the 3rd one (index 2), or the last one if fewer than 3
                const lastValidArg = providedArgs[Math.min(2, providedArgs.length - 2)] || 'set';
                console.error(chalk.red(`Error: No more arguments are required after '${lastValidArg}'.`));
                process.exit(1);
            } else {
                process.stderr.write(str);
            }
        }
    });
    setCmd.argument('[type]', 'Type of credentials to set: all, near, or phala')
        .argument('[network]', 'Network: testnet or mainnet (only for near/all)')
        .argument('[credentialOption]', 'Credential option: create-new or existing-account (only for testnet)')
        .action(async (type, network, credentialOption) => {
            await setAction(type, network, credentialOption);
        });
    
    // auth get command
    const getCmd = new Command('get');
    getCmd.description('Get Shade Agent CLI credentials');
    getCmd.configureOutput({
        writeErr: (str) => {
            if (str.includes('too many arguments')) {
                // Get the last valid argument from the command (get accepts max 2 args)
                const args = process.argv.slice(2);
                const authIndex = args.indexOf('auth');
                const getIndex = args.indexOf('get', authIndex);
                const providedArgs = args.slice(getIndex + 1);
                // Last valid argument is the 2nd one (index 1), or the last one if fewer than 2
                const lastValidArg = providedArgs[Math.min(1, providedArgs.length - 2)] || 'get';
                console.error(chalk.red(`Error: No more arguments are required after '${lastValidArg}'.`));
                process.exit(1);
            } else {
                process.stderr.write(str);
            }
        }
    });
    getCmd.argument('[type]', 'Type of credentials to get: all, near, or phala')
        .argument('[network]', 'Network: testnet or mainnet (only for near/all)')
        .action(async (type, network) => {
            await getAction(type, network);
        });
    
    // auth clear command
    const clearCmd = new Command('clear');
    clearCmd.description('Clear Shade Agent CLI credentials');
    clearCmd.configureOutput({
        writeErr: (str) => {
            if (str.includes('too many arguments')) {
                // Get the last valid argument from the command (clear accepts max 2 args)
                const args = process.argv.slice(2);
                const authIndex = args.indexOf('auth');
                const clearIndex = args.indexOf('clear', authIndex);
                const providedArgs = args.slice(clearIndex + 1);
                // Last valid argument is the 2nd one (index 1), or the last one if fewer than 2
                const lastValidArg = providedArgs[Math.min(1, providedArgs.length - 2)] || 'clear';
                console.error(chalk.red(`Error: No more arguments are required after '${lastValidArg}'.`));
                process.exit(1);
            } else {
                process.stderr.write(str);
            }
        }
    });
    clearCmd.argument('[type]', 'Type of credentials to clear: all, near, or phala')
        .argument('[network]', 'Network: all, testnet, or mainnet (only for near/all)')
        .action(async (type, network) => {
            await clearAction(type, network);
        });
    
    cmd.addCommand(setCmd);
    cmd.addCommand(getCmd);
    cmd.addCommand(clearCmd);
    
    // Default action: show selector if no subcommand provided
    cmd.action(async (invalidArg) => {
        // If an argument was provided, it's not a valid subcommand
        if (invalidArg) {
            console.error(chalk.red(`Error: '${invalidArg}' is not a valid subcommand for 'auth'.`));
            console.error(chalk.yellow('\nAvailable subcommands:'));
            console.error(`  ${chalk.yellow('set')} - ${chalk.blue('Set Shade Agent CLI credentials')}`);
            console.error(`  ${chalk.yellow('get')} - ${chalk.blue('Get Shade Agent CLI credentials')}`);
            console.error(`  ${chalk.yellow('clear')} - ${chalk.blue('Clear Shade Agent CLI credentials')}`);
            process.exit(1);
        }
        
        try {
            const subcommand = await select({
                message: 'What would you like to do?',
                choices: [
                    { name: `${chalk.yellow('set')} - ${chalk.blue('Set Shade Agent CLI credentials')}`, value: 'set' },
                    { name: `${chalk.yellow('get')} - ${chalk.blue('Get Shade Agent CLI credentials')}`, value: 'get' },
                    { name: `${chalk.yellow('clear')} - ${chalk.blue('Clear Shade Agent CLI credentials')}`, value: 'clear' },
                ],
            });
            
            // Execute the selected subcommand action
            if (subcommand === 'get') {
                await getAction();
            } else if (subcommand === 'set') {
                await setAction();
            } else if (subcommand === 'clear') {
                await clearAction();
            }
        } catch (error) {
            // ExitPromptError is handled globally in cli.js
            if (isExitPromptError(error)) {
                process.exit(0);
            }
            throw error;
        }
    });
    
    return cmd;
}
