import { Entry } from '@napi-rs/keyring';

// Service name for the keychain
const SERVICE_NAME = 'shade-agent-cli';

// Get NEAR credentials for a network (testnet or mainnet)
export async function getNearCredentials(network) {
    try {
        const accountEntry = new Entry(SERVICE_NAME, `${network}_account`);
        const keyEntry = new Entry(SERVICE_NAME, `${network}_privateKey`);
        
        const accountId = accountEntry.getPassword();
        const privateKey = keyEntry.getPassword();
        
        // getPassword() returns null if entry doesn't exist
        if (!accountId || !privateKey) {
            return null;
        }
        
        return { accountId, privateKey };
    } catch (error) {
        // Entry doesn't exist or other error
        return null;
    }
}

// Set NEAR credentials for a network (testnet or mainnet)
export async function setNearCredentials(network, accountId, privateKey) {
    const accountEntry = new Entry(SERVICE_NAME, `${network}_account`);
    const keyEntry = new Entry(SERVICE_NAME, `${network}_privateKey`);
    
    accountEntry.setPassword(accountId);
    keyEntry.setPassword(privateKey);
}


// Delete NEAR credentials for a network (testnet or mainnet)
export async function deleteNearCredentials(network) {
    const accountEntry = new Entry(SERVICE_NAME, `${network}_account`);
    const keyEntry = new Entry(SERVICE_NAME, `${network}_privateKey`);
    
    // Check if credentials exist before deleting
    const exists = await hasNearCredentials(network);
    
    // deletePassword() doesn't throw if entry doesn't exist
    accountEntry.deletePassword();
    keyEntry.deletePassword();
    
    return exists;
}

// Check if NEAR credentials exist for a network (testnet or mainnet)
export async function hasNearCredentials(network) {
    const credentials = await getNearCredentials(network);
    return credentials !== null;
}

// Get PHALA_KEY from keychain
export async function getPhalaKey() {
    try {
        const phalaEntry = new Entry(SERVICE_NAME, 'phala_key');
        const phalaKey = phalaEntry.getPassword();
        return phalaKey;
    } catch (error) {
        // Entry doesn't exist or other error
        return null;
    }
}

// Set PHALA_KEY in keychain
export async function setPhalaKey(phalaKey) {
    const phalaEntry = new Entry(SERVICE_NAME, 'phala_key');
    phalaEntry.setPassword(phalaKey);
}

// Check if PHALA_KEY exists
export async function hasPhalaKey() {
    try {
        const phalaKey = await getPhalaKey();
        return phalaKey !== null;
    } catch (error) {
        // Entry doesn't exist or other error
        return false;
    }
}

// Delete PHALA_KEY from keychain
export async function deletePhalaKey() {
    const phalaEntry = new Entry(SERVICE_NAME, 'phala_key');
    const exists = await hasPhalaKey();
    phalaEntry.deletePassword();
    return exists;
}
