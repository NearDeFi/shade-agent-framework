import { Command } from 'commander';
import select from '@inquirer/select';
import input from '@inquirer/input';
import confirm from '@inquirer/confirm';
import { KeyPair } from '@near-js/crypto';
import { generate as randomWords } from 'random-words';
import { getCredentials, setCredentials, hasCredentials, getPhalaKey, setPhalaKey, hasPhalaKey } from '../../utils/keystore.js';
import chalk from 'chalk';

// Generate a random account ID using two random words
function generateRandomAccountId() {
    return randomWords({ exactly: 2, join: '-' });
}

// Helper function to create account via faucet service
async function createAccountViaFaucet(accountId, publicKey) {
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
                return handleTransactionOutcome(outcome, accountId);
            }
            throw new Error('Faucet service did not return a valid transaction response');
        }
        
        const outcome = result.final_execution_outcome;
        
        return handleTransactionOutcome(outcome, accountId);
    } catch (error) {
        console.error(chalk.red(`\nError creating account via faucet: ${error.message}`));
        throw error;
    }
}

// Helper function to handle transaction outcome
function handleTransactionOutcome(outcome, accountId) {
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
                console.log(chalk.cyan(`  Transaction ID: ${txId}`));
                console.log(chalk.cyan(`  View transaction: https://explorer.testnet.near.org/transactions/${txId}`));
                throw new Error('Account creation failed - faucet service returned false');
            }
            
            // Success!
            console.log(chalk.green(`✓ Account created successfully!`));
            console.log(chalk.cyan(`  Transaction ID: ${txId}`));
            console.log(chalk.cyan(`  View transaction: https://explorer.testnet.near.org/transactions/${txId}`));
            return true;
        }
        
        // Handle Failure
        if (outcome.status.Failure) {
            const failure = outcome.status.Failure;
            console.log(chalk.yellow(`\nWarning: Account creation failed`));
            console.log(chalk.cyan(`  Transaction ID: ${txId}`));
            console.log(chalk.cyan(`  View transaction: https://explorer.testnet.near.org/transactions/${txId}`));
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
    console.log(chalk.cyan(`  Transaction ID: ${txId}`));
    console.log(chalk.cyan(`  View transaction: https://explorer.testnet.near.org/transactions/${txId}`));
    return true;
}

// Helper function to prompt for credentials or use autocomplete for testnet
async function promptAndStoreCredentials(network) {
    let accountId, privateKey;
    
    // For testnet, offer autocomplete option
    if (network === 'testnet') {
        const credentialOption = await select({
            message: 'How would you like to set up credentials?',
            choices: [
                { name: 'Generate random account ID and keypair automatically', value: 'autocomplete' },
                { name: 'Enter credentials manually', value: 'manual' },
            ],
        });
        
        if (credentialOption === 'autocomplete') {
            // Generate account ID using two random words
            accountId = `${generateRandomAccountId()}.testnet`;
            
            // Generate a new keypair
            const keyPair = KeyPair.fromRandom("ed25519");
            // Get the private key in the format "ed25519:..."
            privateKey = keyPair.toString();
            const publicKey = keyPair.getPublicKey().toString();
            
            console.log(chalk.blue(`\nGenerated credentials:`));
            console.log(chalk.cyan(`  Account ID: ${accountId}`));
            console.log(chalk.cyan(`  Private Key: ${privateKey}`));
            console.log(chalk.cyan(`  Public Key: ${publicKey}`));
            
            // Create account via faucet service - must succeed before storing credentials
            await createAccountViaFaucet(accountId, publicKey);
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
        // For mainnet, always prompt manually
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
    console.log(chalk.green(`✓ Credentials stored for ${network}`));
    console.log(chalk.green(`\nStored credentials for ${network}:`));
    console.log(chalk.cyan(`  Account ID: ${accountId.trim()}`));
    console.log(chalk.cyan(`  Private Key: ${privateKey.trim()}`));
}

export function authCommand() {
    const cmd = new Command('auth');
    cmd.description('Set up authentication credentials');
    
    // Define the set action function
    const setAction = async () => {
        try {
            // Ask what to set
            const whatToSet = await select({
                message: 'What would you like to set?',
                choices: [
                    { name: 'All (NEAR + PHALA)', value: 'both' },
                    { name: 'Just NEAR (network credentials)', value: 'network' },
                    { name: 'Just PHALA (API key)', value: 'phala' },
                ],
            });

            if (whatToSet === 'network' || whatToSet === 'both') {
                const network = await select({
                    message: 'Select network:',
                    choices: [
                        { name: 'Testnet', value: 'testnet' },
                        { name: 'Mainnet', value: 'mainnet' },
                    ],
                });

                // Prompt for credentials (will replace if they exist)
                await promptAndStoreCredentials(network);
            }

            if (whatToSet === 'phala' || whatToSet === 'both') {
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
            // Handle SIGINT gracefully - exit silently
            if (error.name === 'ExitPromptError' || error.message?.includes('SIGINT')) {
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
    const getAction = async () => {
        try {
            const whatToGet = await select({
                message: 'What would you like to view?',
                choices: [
                    { name: 'All (NEAR + PHALA)', value: 'both' },
                    { name: 'Just NEAR (network credentials)', value: 'network' },
                    { name: 'Just PHALA (API key)', value: 'phala' },
                ],
            });

            if (whatToGet === 'network' || whatToGet === 'both') {
                const network = await select({
                    message: 'Select network:',
                    choices: [
                        { name: 'Testnet', value: 'testnet' },
                        { name: 'Mainnet', value: 'mainnet' },
                    ],
                });
                
                const credentials = await getCredentials(network);
                
                if (!credentials) {
                    console.log(chalk.yellow(`No credentials found for ${network}`));
                    console.log(chalk.yellow(`Use 'shade auth set' to store credentials`));
                } else {
                    console.log(chalk.green(`\nCredentials for ${network}:`));
                    console.log(chalk.cyan(`Account ID: ${credentials.accountId}`));
                    console.log(chalk.cyan(`Private Key: ${credentials.privateKey}`));
                }
            }

            if (whatToGet === 'phala' || whatToGet === 'both') {
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
            // Handle SIGINT gracefully - exit silently
            if (error.name === 'ExitPromptError' || error.message?.includes('SIGINT')) {
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
    setCmd.description('Store credentials for a network');
    setCmd.action(setAction);
    
    // auth get command
    const getCmd = new Command('get');
    getCmd.description('Retrieve credentials for a network');
    getCmd.action(getAction);
    
    cmd.addCommand(setCmd);
    cmd.addCommand(getCmd);
    
    // Default action: show selector if no subcommand provided
    cmd.action(async () => {
        try {
            const subcommand = await select({
                message: 'What would you like to do?',
                choices: [
                    { name: 'Set - Store credentials for a network', value: 'set' },
                    { name: 'Get - Retrieve stored credentials', value: 'get' },
                ],
            });
            
            // Execute the selected subcommand action
            if (subcommand === 'get') {
                await getAction();
            } else if (subcommand === 'set') {
                await setAction();
            }
        } catch (error) {
            // Handle SIGINT gracefully - exit silently
            if (error.name === 'ExitPromptError' || error.message?.includes('SIGINT')) {
                process.exit(0);
            }
            throw error;
        }
    });
    
    return cmd;
}
