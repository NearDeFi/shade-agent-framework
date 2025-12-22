import input from '@inquirer/input';
import confirm from '@inquirer/confirm';
import { validateAndSelectOption } from '../../utils/error-handler.js';

// Select credential type (all/near/phala)
export async function selectCredentialType(typeArg, actionType) {
    const typeOptions = {
        set: [
            { value: 'all', description: 'Set both NEAR and PHALA credentials' },
            { value: 'near', description: 'Set NEAR master account only' },
            { value: 'phala', description: 'Set PHALA API key only' }
        ],
        get: [
            { value: 'all', description: 'Get both NEAR and PHALA credentials' },
            { value: 'near', description: 'Get NEAR master account only' },
            { value: 'phala', description: 'Get PHALA API key only' }
        ],
        clear: [
            { value: 'all', description: 'Clear both NEAR and PHALA credentials' },
            { value: 'near', description: 'Clear NEAR master account only' },
            { value: 'phala', description: 'Clear PHALA API key only' }
        ]
    };
    
    return await validateAndSelectOption({
        value: typeArg,
        options: typeOptions[actionType],
        message: `What would you like to ${actionType}?`
    });
}

// Select network (testnet/mainnet, optionally 'all' for clear)
export async function selectNetwork(networkArg, allowAll = false) {
    const networkOptions = allowAll 
        ? [
            { value: 'all', description: 'Clear both networks' },
            { value: 'testnet', description: 'NEAR Testnet' },
            { value: 'mainnet', description: 'NEAR Mainnet' }
          ]
        : [
            { value: 'testnet', description: 'NEAR Testnet' },
            { value: 'mainnet', description: 'NEAR Mainnet' }
          ];
    
    return await validateAndSelectOption({
        value: networkArg,
        options: networkOptions,
        message: 'Select network:'
    });
}

// Select credential option (create-new/existing-account) for testnet
export async function selectCredentialOption(credentialOptionArg) {
    const options = [
        { value: 'create-new', description: 'Generate a random new account' },
        { value: 'existing-account', description: 'Enter credentials for an existing account' }
    ];
    
    return await validateAndSelectOption({
        value: credentialOptionArg,
        options,
        message: 'How would you like to set up credentials?'
    });
}

// Prompt for account credentials (account ID and private key)
export async function promptForAccountCredentials() {
    const accountId = await input({
        message: 'Enter account ID:',
        validate: (value) => {
            if (!value || value.trim().length === 0) {
                return 'Account ID is required';
            }
            return true;
        },
    });
    
    const privateKey = await input({
        message: 'Enter private key:',
        validate: (value) => {
            if (!value || value.trim().length === 0) {
                return 'Private key is required';
            }
            if (!value.startsWith('ed25519:') && !value.startsWith('secp256k1:')) {
                return 'Private key should start with "ed25519:" or "secp256k1:"';
            }
            return true;
        },
    });
    
    return { accountId: accountId.trim(), privateKey: privateKey.trim() };
}

// Prompt for PHALA API key
export async function promptForPhalaKey() {
    return await input({
        message: 'Enter PHALA API key:',
        validate: (value) => {
            if (!value || value.trim().length === 0) {
                return 'PHALA API key is required';
            }
            return true;
        },
    });
}

// Confirm overwriting existing credentials
export async function confirmOverwriteCredentials(message = 'Do you want to continue?') {
    return await confirm({
        message,
        default: false
    });
}

