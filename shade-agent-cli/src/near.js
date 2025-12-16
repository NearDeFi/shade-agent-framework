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

export async function createAccount() {
    const contractId = config.deployment.agent_contract.contract_id;
    const masterAccount = config.masterAccount;
    const contractAccount = config.contractAccount;
    // Use only the first provider for existence check to avoid failover on AccountDoesNotExist
    // Check if the contract account exists and delete it if it does
    try {
        await contractAccount.getBalance();
        console.log("Contract account already exists, deleting it");
        await contractAccount.deleteAccount(masterAccount.accountId);
        await sleep(1000);
    } catch (e) {
        if (e.type === 'AccountDoesNotExist') {
            console.log("Contract account does not exist, creating it");
        } else {
            console.log('Error checking contract account existence', e);
            await contractAccount.deleteAccount(masterAccount.accountId);
            await sleep(1000);
        }
    }

    // Create the contract account
    try {
        console.log('Creating contract account');
        await masterAccount.createAccount(
            contractId,
            await masterAccount.getSigner().getPublicKey(),
            NEAR.toUnits(config.deployment.agent_contract.deploy_custom.funding_amount),
        );
        await sleep(1000);
    } catch (e) {
        console.log('Error creating contract account', e);
        process.exit(1);
    }
}


export async function deployCustomContractFromWasm() {
    const wasmPath = config.deployment.agent_contract.deploy_custom.path_to_wasm;
    return await innerDeployCustomContractFromWasm(wasmPath);
}

async function innerDeployCustomContractFromWasm(wasmPath) {
    const contractAccount = config.contractAccount;
    try {
        // Deploys the contract bytes (requires more funding)
        const file = fs.readFileSync(wasmPath);
        await contractAccount.deployContract(new Uint8Array(file));
        console.log('Custom contract deployed:', contractAccount.accountId);
        await sleep(1000);
    } catch (e) {
        console.log('Error deploying the custom contract from WASM', e);
        process.exit(1);
    }
}

function resolveWasmPath(absoluteSourcePath) {
    const cargoTomlPath = path.join(absoluteSourcePath, 'Cargo.toml');
    if (!fs.existsSync(cargoTomlPath)) {
        console.log(`Cargo.toml not found at ${cargoTomlPath}`);
        process.exit(1);
    }

    const cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
    const nameMatch = cargoToml.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (!nameMatch || !nameMatch[1]) {
        console.log('Could not find package name in Cargo.toml');
        process.exit(1);
    }

    const crateName = nameMatch[1].replace(/-/g, '_');
    const wasmPath = path.join(absoluteSourcePath, 'target', 'near', `${crateName}.wasm`);
    if (!fs.existsSync(wasmPath)) {
        console.log(`WASM not found at ${wasmPath} make sure the contract build produced this file.`);
        process.exit(1);
    }

    return wasmPath;
}

export async function deployCustomContractFromSource() {
    const sourcePath = config.deployment.agent_contract.deploy_custom.path_to_contract;
    try {
        // Resolve to absolute path for Docker volume mount
        const absoluteSourcePath = path.resolve(process.cwd(), sourcePath);
        console.log(`Building the contract from source`);

        execSync(
            `docker run --rm -v "${absoluteSourcePath}":/workspace pivortex/near-builder@sha256:cdffded38c6cff93a046171269268f99d517237fac800f58e5ad1bcd8d6e2418 cargo near build non-reproducible-wasm`,
            { stdio: 'pipe' }
        );

        const wasmPath = resolveWasmPath(absoluteSourcePath);
        await innerDeployCustomContractFromWasm(wasmPath);
    } catch (e) {
        console.log('Error building/deploying the custom contract from source', e);
        process.exit(1);
    }
}

export async function initContract() {
    const contractAccount = config.contractAccount;
    const contractId = config.deployment.agent_contract.contract_id;
    // Initializes the contract based on deployment config
    console.log('Initializing the contract');
    try {
        const initCfg = config.deployment.agent_contract.deploy_custom.init;

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

        await contractAccount.callFunctionRaw({
            contractId,
            methodName,
            args,
            gas: tgasToGas(initCfg.tgas),
        });
        await sleep(1000);
    } catch (e) {
        console.log('Error initializing the contract', e);
        process.exit(1);
    }
}

export async function approveCodehash() {
    const masterAccount = config.masterAccount;
    const contractId = config.deployment.agent_contract.contract_id;
    // Approves the specified codehash based on deployment config
    console.log('Approving the codehash');
    try {
        const approveCfg = config.deployment.approve_codehash;

        const args =
            typeof approveCfg.args === 'string'
                ? JSON.parse(approveCfg.args)
                : approveCfg.args;

        // Resolve codehash placeholder based on environment and docker-compose
        const requiresTee = config.deployment.environment === 'TEE';
        const composePath = config.deployment?.build_docker_image?.docker_compose_path
            ? path.resolve(config.deployment.build_docker_image.docker_compose_path)
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

        await masterAccount.callFunctionRaw({
            contractId,
            methodName: approveCfg.method_name,
            args,
            gas: tgasToGas(approveCfg.tgas),
        });
        await sleep(1000);
    } catch (e) {
        console.log('Error approving the codehash', e);
        process.exit(1);
    }
}