import { KeyPair } from '@near-js/crypto';
import { setNearCredentials, hasNearCredentials, getNearCredentials } from '../../utils/keystore.js';
import chalk from 'chalk';
import { selectCredentialOption, promptForAccountCredentials, confirmOverwriteCredentials } from './prompts.js';
import { createAccountViaFaucet } from './faucet.js';
import { generate as randomWords } from 'random-words';

// Generate a random account ID using two random words
function generateRandomAccountId() {
    return randomWords({ exactly: 2, join: '-' });
}

// Helper function to prompt for credentials or create new account for testnet
export async function promptAndStoreCredentials(network, credentialOptionArg = null) {
    // Check if credentials already exist and warn user
    const existingCredentials = await hasNearCredentials(network);
    if (existingCredentials) {
        const currentCredentials = await getNearCredentials(network);
        console.log(chalk.yellow(`\n⚠️  Warning: You already have credentials stored for ${network}.`));
        console.log(chalk.yellow(`   Current Account ID: ${currentCredentials.accountId}`));
        console.log(chalk.yellow(`\n   Make sure you have recorded your account ID and private key elsewhere,`));
        console.log(chalk.yellow(`   as they will no longer be stored in the CLI after setting new credentials.`));
        console.log('');
        
        const shouldContinue = await confirmOverwriteCredentials();
        
        if (!shouldContinue) {
            console.log(chalk.yellow('Cancelled.'));
            process.exit(0);
        }
        console.log('');
    }
    
    let accountId, privateKey;
    
    // For testnet, offer create-new option
    if (network === 'testnet') {
        const credentialOption = await selectCredentialOption(credentialOptionArg);
        
        if (credentialOption === 'create-new') {
            // Generate account ID using two random words
            accountId = `${generateRandomAccountId()}.testnet`;
            
            // Generate a new keypair
            const keyPair = KeyPair.fromRandom("ed25519");
            // Get the private key in the format "ed25519:..."
            privateKey = keyPair.toString();
            const publicKey = keyPair.getPublicKey().toString();
            
            // Create account via faucet service - must succeed before storing credentials
            await createAccountViaFaucet(accountId, publicKey);
        } else {
            const credentials = await promptForAccountCredentials();
            accountId = credentials.accountId;
            privateKey = credentials.privateKey;
        }
    } else {
        // For mainnet, always use existing-account (no account creation via faucet)
        const credentials = await promptForAccountCredentials();
        accountId = credentials.accountId;
        privateKey = credentials.privateKey;
    }
    
    await setNearCredentials(network, accountId, privateKey);
    console.log(chalk.green(`✓ Master account stored for ${network}`));
    console.log(chalk.cyan(`  Account ID: ${accountId}`));
    console.log(chalk.cyan(`  Private Key: ${privateKey}`));
}

