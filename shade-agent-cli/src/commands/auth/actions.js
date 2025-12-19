import { getNearCredentials, getPhalaKey, setPhalaKey, deleteNearCredentials, deletePhalaKey } from '../../utils/keystore.js';
import { isExitPromptError } from '../../utils/error-handler.js';
import chalk from 'chalk';
import { selectCredentialType, selectNetwork, promptForPhalaKey } from './prompts.js';
import { promptAndStoreCredentials } from './credentials.js';

// Set credentials action
export async function setCredentials(whatToSetArg, networkArg = null, credentialOptionArg = null) {
    try {
        const whatToSet = await selectCredentialType(whatToSetArg, 'set');

        if (whatToSet === 'near' || whatToSet === 'all') {
            const network = await selectNetwork(networkArg);
            await promptAndStoreCredentials(network, credentialOptionArg);
        }

        if (whatToSet === 'phala' || whatToSet === 'all') {
            // Prompt for PHALA API key (will replace if it exists)
            const phalaKey = await promptForPhalaKey();
            
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
        console.log(chalk.red(`Error: ${error.message}`));
        process.exit(1);
    }
}

// Get credentials action
export async function getCredentials(whatToGetArg, networkArg = null) {
    try {
        const whatToGet = await selectCredentialType(whatToGetArg, 'get');

        if (whatToGet === 'near' || whatToGet === 'all') {
            const network = await selectNetwork(networkArg);
            const credentials = await getNearCredentials(network);
            
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
        console.log(chalk.red(`Error: ${error.message}`));
        process.exit(1);
    }
}

// Clear credentials action
export async function clearCredentials(whatToClearArg, networkArg = null) {
    try {
        const whatToClear = await selectCredentialType(whatToClearArg, 'clear');

        if (whatToClear === 'near' || whatToClear === 'all') {
            const network = await selectNetwork(networkArg, true);

            if (network === 'all') {
                // Clear both testnet and mainnet
                const testnetDeleted = await deleteNearCredentials('testnet');
                const mainnetDeleted = await deleteNearCredentials('mainnet');
                
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
                const deleted = await deleteNearCredentials(network);
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
        console.log(chalk.red(`Error: ${error.message}`));
        process.exit(1);
    }
}

