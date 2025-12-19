import { KeyPair } from '@near-js/crypto';
import { setNearCredentials } from '../../utils/keystore.js';
import chalk from 'chalk';
import { selectCredentialOption, promptForAccountCredentials } from './prompts.js';
import { createAccountViaFaucet } from './faucet.js';
import { generate as randomWords } from 'random-words';

// Generate a random account ID using two random words
function generateRandomAccountId() {
    return randomWords({ exactly: 2, join: '-' });
}

// Helper function to prompt for credentials or create new account for testnet
export async function promptAndStoreCredentials(network, credentialOptionArg = null) {
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

