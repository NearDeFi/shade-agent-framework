import { replacePlaceholders } from './placeholders.js';

// Resolve deployment-specific placeholders in args
export function resolveDeploymentPlaceholders(args, accountId, network, environment, codehash) {
    const replacements = {};
    
    if (accountId) {
        replacements['<MASTER_ACCOUNT_ID>'] = accountId;
    }
    replacements['<DEFAULT_MPC_CONTRACT_ID>'] = network === 'mainnet' ? 'v1.signer' : 'v1.signer-prod.testnet';
    replacements['<REQUIRES_TEE>'] = environment === 'TEE';
    if (codehash) {
        replacements['<CODEHASH>'] = codehash;
    }
    
    return replacePlaceholders(args, replacements);
}

