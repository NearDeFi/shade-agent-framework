import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { NEAR } from '@near-js/tokens';
import { parse } from 'yaml';
import chalk from 'chalk';
import { getConfig } from '../../utils/config.js';
import { replacePlaceholder, hasPlaceholder } from '../../utils/placeholders.js';

// Sleep for the specified number of milliseconds
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tgasToGas(tgas) {
    return BigInt(tgas) * BigInt(1000000000000);
}

export async function createAccount() {
    const config = await getConfig();
    const contractId = config.deployment.agent_contract.contract_id;
    const masterAccount = config.masterAccount;
    const contractAccount = config.contractAccount;
    const fundingAmount = config.deployment.agent_contract.deploy_custom.funding_amount;
    
    // Check if master account has enough balance (including contract account balance if it exists)
    const requiredBalance = fundingAmount + 0.1;
    const masterBalance = await masterAccount.getBalance(NEAR);
    const masterBalanceDecimal = parseFloat(NEAR.toDecimal(masterBalance));
    
    // Get contract account balance if it exists (will be returned to master when deleted)
    let contractAccountExists = false;
    let contractBalanceDecimal = 0;
    try {
        const state = await contractAccount.getState();
        contractAccountExists = true;
        // Extract balance from state - state.balance.total is a BigInt
        if (state && state.balance && state.balance.total) {
            const contractBalance = state.balance.total;
            contractBalanceDecimal = parseFloat(NEAR.toDecimal(contractBalance));
        }
    } catch (e) {
        // Contract account doesn't exist, balance is 0 - this is fine
        if (e.type !== 'AccountDoesNotExist') {
            throw e;
        }
    }
    
    const totalBalance = masterBalanceDecimal + contractBalanceDecimal;
    
    if (totalBalance < requiredBalance) {
        console.error(chalk.red(`Error: You need to fund your master account ${masterAccount.accountId}`));
        console.error(chalk.yellow(`It has balance ${totalBalance} NEAR (master: ${masterBalanceDecimal} NEAR${contractBalanceDecimal > 0 ? ` + contract: ${contractBalanceDecimal} NEAR` : ''}) but needs ${requiredBalance} NEAR (${fundingAmount} NEAR for the contract + 0.1 NEAR for transaction fees)`));
        if (config.deployment.network === 'testnet') {
            console.error(chalk.cyan(`\n💬 Need testnet NEAR? Ask in the Shade Agent Telegram Group: https://t.me/+mrNSq_0tp4IyNzg8`));
        }
        process.exit(1);
    }
    
    // Delete the contract account if it exists
    if (contractAccountExists) {
        console.log("Contract account already exists, deleting it");
        try {
            await contractAccount.deleteAccount(masterAccount.accountId);
            await sleep(1000);
        } catch (deleteError) {
            if (deleteError.type === 'AccessKeyDoesNotExist') {
                console.error(chalk.red('Error: You cannot delete a contract account that does not have the same public key as your master account, pick a new unique contract_id or change back to your old master account for which you created the contract account with'));
                process.exit(1);
            }
            throw deleteError;
        }
    } else {
        console.log("Contract account does not exist, creating it");
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
    const config = await getConfig();
    const wasmPath = config.deployment.agent_contract.deploy_custom.wasm_path;
    return await innerDeployCustomContractFromWasm(wasmPath);
}

async function innerDeployCustomContractFromWasm(wasmPath) {
    const config = await getConfig();
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
    const config = await getConfig();
    const sourcePath = config.deployment.agent_contract.deploy_custom.source_path;
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
    const config = await getConfig();
    const contractAccount = config.contractAccount;
    const contractId = config.deployment.agent_contract.contract_id;
    // Initializes the contract based on deployment config
    console.log('Initializing the contract');
    try {
        const initCfg = config.deployment.agent_contract.deploy_custom.init;

        const methodName = initCfg.method_name;

        // Replace placeholders in args
        let args = replacePlaceholder(initCfg.args, '<MASTER_ACCOUNT_ID>', config.accountId);
        args = replacePlaceholder(args, '<DEFAULT_MPC_CONTRACT_ID>', 
            config.deployment.network === 'mainnet' ? 'v1.signer' : 'v1.signer-prod.testnet');
        args = replacePlaceholder(args, '<REQUIRES_TEE>', config.deployment.environment === 'TEE');

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

export async function deleteContractKey() {
    const config = await getConfig();
    const contractAccount = config.contractAccount;
    const masterAccount = config.masterAccount;
    
    // Get the master account's public key (the same key used to create the contract account)
    const publicKey = await masterAccount.getSigner().getPublicKey();
    
    try {
        console.log('Deleting contract key to lock the account');
        await contractAccount.deleteKey(publicKey);
        await sleep(1000);
        console.log('Contract key deleted successfully');
    } catch (e) {
        console.log('Error deleting contract key', e);
        process.exit(1);
    }
}

export async function approveCodehash() {
    const config = await getConfig();
    const masterAccount = config.masterAccount;
    const contractId = config.deployment.agent_contract.contract_id;
    // Approves the specified codehash based on deployment config
    console.log('Approving the codehash');
    try {
        const approveCfg = config.deployment.approve_codehash;

        // Resolve codehash placeholder based on environment and docker-compose
        const requiresTee = config.deployment.environment === 'TEE';
        let args = approveCfg.args;

        // Only process codehash if the placeholder exists in args
        if (hasPlaceholder(approveCfg.args, '<CODEHASH>')) {
            let codehashValue = null;

            if (requiresTee) {
                // For TEE, get codehash from docker-compose file
                const composePath = path.resolve(config.deployment.docker_compose_path);
                const compose = fs.readFileSync(composePath, 'utf8');
                // Parse YAML to specifically target shade-agent-app image
                const doc = parse(compose);
                const image = doc?.services?.['shade-agent-app']?.image;
                const imageMatch = typeof image === 'string' ? image.match(/@sha256:([a-f0-9]{64})/i) : null;
                if (!imageMatch) {
                    console.log(`Could not find codehash for shade-agent-app in ${composePath}`);
                    process.exit(1);
                }
                codehashValue = imageMatch[1];
            } else {
                // For local environment
                codehashValue = 'not-in-a-tee';
            }

            // Replace <CODEHASH> placeholder anywhere in args
            args = replacePlaceholder(approveCfg.args, '<CODEHASH>', codehashValue);
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

