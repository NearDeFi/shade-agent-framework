import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { NEAR } from '@near-js/tokens';
import { config } from './config.js';

// Sleep for the specified number of milliseconds
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tgasToGas(tgas) {
    return BigInt(tgas) * BigInt(1000000000000);
}

export async function createAccount(contractId, masterAccount, contractAccount) {
    // Use only the first provider for existence check to avoid failover on AccountDoesNotExist
    // Check if the contract account exists and delete it if it does
    try {
        await contractAccount.getBalance();
        console.log("Account already exists, deleting...");
        await contractAccount.deleteAccount(masterAccount.accountId);
        console.log("Account deleted successfully");
        await sleep(1000);
    } catch (e) {
        if (e.type === 'AccountDoesNotExist') {
            console.log("Account does not exist, creating new one...");
        } else {
            console.log('Error checking account existence', e);
            await contractAccount.deleteAccount(masterAccount.accountId);
            console.log("Account deleted successfully");
            await sleep(1000);
        }
    }

    // Create the contract account
    try {
        console.log('Creating account...');
        await masterAccount.createAccount(
            contractId,
            await masterAccount.getSigner().getPublicKey(),
            NEAR.toUnits(config.deployment.deploy_custom.funding_amount),
        );
        console.log('Contract account created:', contractId);
        await sleep(1000);
        return true;
    } catch (e) {
        console.log('Error creating account', e);
        return false;
    }
}

export async function deployCustomContractFromWasm(contractAccount, wasmPath) {
    try {
        // Deploys the contract bytes (requires more funding)
        const file = fs.readFileSync(wasmPath);
        await contractAccount.deployContract(file);
        console.log('Custom contract deployed:', contractAccount.accountId);
        await sleep(1000);
        return true;
    } catch (e) {
        console.log('Error deploying custom contract', e);
        return false;
    }
}

export async function deployCustomContractFromSource(contractAccount, sourcePath) {
    try {
        // Resolve to absolute path for Docker volume mount
        const absoluteSourcePath = path.resolve(process.cwd(), sourcePath);
        console.log(`Building contract from source at ${absoluteSourcePath}...`);

        if (config.deployment.os === 'mac') {
            // Use Docker-based builder on macOS
            execSync(
                `docker run --rm -v "${absoluteSourcePath}":/workspace pivortex/near-builder@sha256:cdffded38c6cff93a046171269268f99d517237fac800f58e5ad1bcd8d6e2418 cargo near build non-reproducible-wasm`,
                { stdio: 'inherit' }
            );
        } else {
            // Use local cargo near on non-mac
            execSync('cargo near build non-reproducible-wasm', { cwd: absoluteSourcePath, stdio: 'inherit' });
        }

        const wasmPath = path.join(absoluteSourcePath, 'target', 'near', 'shade_contract_template.wasm'); // TODO: Make this dynamic
        return await deployCustomContractFromWasm(contractAccount, wasmPath);
    } catch (e) {
        console.log('Error building/deploying custom contract from source', e);
        return false;
    }
}


export async function initContract(contractAccount, contractId, masterAccount) {
    // Initializes the contract based on deployment config
    try {
        const initCfg = config.deployment.deploy_custom?.init;
        if (!initCfg) {
            throw new Error('Missing init configuration in deployment');
        }

        const methodName = initCfg.method_name;

        const resolvePlaceholders = (val) => {
            if (typeof val === 'string') {
                if (val === '<OWNER_ACCOUNT_ID>') return config.accountId;
                if (val === '<MPC_CONTRACT_ID>') {
                    return config.deployment.network === 'mainnet' ? 'v1.signer' : 'v1.signer-prod.testnet';
                }
                if (val === '<REQUIRES_TEE>') {
                    return config.deployment.environment === 'TEE';
                }
                return val;
            }
            if (Array.isArray(val)) return val.map(resolvePlaceholders);
            if (val && typeof val === 'object') {
                return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, resolvePlaceholders(v)]));
            }
            return val;
        };

        const rawArgs = typeof initCfg.args === 'string' ? JSON.parse(initCfg.args) : initCfg.args;
        const args = resolvePlaceholders(rawArgs);

        const initRes = await contractAccount.callFunctionRaw({
            contractId,
            methodName,
            args,
            gas: tgasToGas(initCfg.tgas),
        });
        console.log('Contract initialized:', initRes.status.SuccessValue === '');
        await sleep(1000);
        return true;
    } catch (e) {
        console.log('Error initializing contract', e);
        return false;
    }
}

export async function approveCodehash(masterAccount, contractId) {
    // Approves the specified codehash based on deployment config
    try {
        const approveCfg = config.deployment.approve_codehash;
        if (!approveCfg) {
            throw new Error('Missing approve_codehash configuration in deployment');
        }

        const args =
            typeof approveCfg.args === 'string'
                ? JSON.parse(approveCfg.args)
                : approveCfg.args;

        // Resolve codehash placeholder based on environment and docker-compose
        const requiresTee = config.deployment.environment === 'TEE';
        const composePath = config.deployment?.docker?.docker_compose_path
            ? path.resolve(config.deployment.docker.docker_compose_path)
            : path.resolve(process.cwd(), 'docker-compose.yaml');

        if (args && typeof args === 'object' && 'codehash' in args) {
            if (args.codehash === '<CODEHASH>' && requiresTee) {
                const compose = fs.readFileSync(composePath, 'utf8');
                // Parse YAML to specifically target shade-agent-app image
                const { parse } = await import('yaml');
                const doc = parse(compose);
                const image = doc?.services?.['shade-agent-app']?.image;
                const imageMatch = typeof image === 'string' ? image.match(/@sha256:([a-f0-9]{64})/i) : null;
                if (!imageMatch) {
                    throw new Error(`Could not find codehash for shade-agent-app in ${composePath}`);
                }
                args.codehash = imageMatch[1];
            } else if (config.deployment.environment === 'local') {
                args.codehash = 'not-in-a-tee';
            }
        }

        const approveRes = await masterAccount.callFunctionRaw({
            contractId,
            methodName: approveCfg.method_name,
            args,
            gas: tgasToGas(approveCfg.tgas),
        });
        console.log('Codehash approved:', approveRes.status.SuccessValue === '');
        await sleep(1000);
        return true;
    } catch (e) {
        console.log('Error approving codehash', e);
        return false;
    }
}