import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { NEAR } from '@near-js/tokens';
import chalk from 'chalk';
import bs58 from 'bs58';
import { getConfig } from '../../utils/config.js';
import { replacePlaceholders } from '../../utils/placeholders.js';
import { tgasToGas } from '../../utils/near.js';
import { checkTransactionOutcome } from '../../utils/transaction-outcome.js';
import { getSudoPrefix } from '../../utils/docker-utils.js';
import { getMeasurements } from '../../utils/measurements.js';

// Sleep for the specified number of milliseconds for nonce problems
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Create the contract account
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
        // Extract balance from state 
        if (state && state.balance && state.balance.total) {
            const contractBalance = state.balance.total;
            contractBalanceDecimal = parseFloat(NEAR.toDecimal(contractBalance));
        }
    } catch (e) {
        // Contract account doesn't exist, balance is 0 - this is fine
        if (e.type !== 'AccountDoesNotExist') {
            console.log(chalk.red(`Error: ${e.message}`));
            process.exit(1);
        }
    }
    
    const totalBalance = masterBalanceDecimal + contractBalanceDecimal;
    
    if (totalBalance < requiredBalance) {
        console.log(chalk.red(`Error: You need to fund your master account ${masterAccount.accountId}`));
        console.log(chalk.yellow(`It has balance ${totalBalance} NEAR (master: ${masterBalanceDecimal} NEAR${contractBalanceDecimal > 0 ? ` + contract: ${contractBalanceDecimal} NEAR` : ''}) but needs ${requiredBalance} NEAR (${fundingAmount} NEAR for the contract + 0.1 NEAR for transaction fees)`));
        if (config.deployment.network === 'testnet') {
            console.log(chalk.cyan(`\n💬 Need testnet NEAR? Ask in the Shade Agent Telegram Group: https://t.me/+mrNSq_0tp4IyNzg8`));
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
                console.log(chalk.red('Error: You cannot delete a contract account that does not have the same public key as your master account, pick a new unique contract_id or change back to your old master account for which you created the contract account with'));
                process.exit(1);
            }
            console.log(chalk.red(`Error: ${deleteError.message}`));
            process.exit(1);
        }
    } else {
        console.log("Contract account does not exist, creating it");
    }

    // Create the contract account
    try {
        console.log('Creating contract account');
        const result = await masterAccount.createAccount(
            contractId,
            await masterAccount.getSigner().getPublicKey(),
            NEAR.toUnits(config.deployment.agent_contract.deploy_custom.funding_amount),
        );
        
        // Check transaction outcome if result is available
        if (result && result.final_execution_outcome) {
            const success = checkTransactionOutcome(result.final_execution_outcome);
            if (!success) {
                console.log(chalk.red('✗ Failed to create contract account'));
                process.exit(1);
            }
        }
        
        await sleep(1000);
    } catch (e) {
        console.log(chalk.red(`Error creating contract account: ${e.message}`));
        process.exit(1);
    }
}

// Deploy the custom contract from a WASM file fetches path from deployment.yaml
export async function deployCustomContractFromWasm() {
    const config = await getConfig();
    const wasmPath = config.deployment.agent_contract.deploy_custom.wasm_path;
    return await innerDeployCustomContractFromWasm(wasmPath);
}

// Deploy the custom contract from a WASM file for a given wasm path
async function innerDeployCustomContractFromWasm(wasmPath) {
    const config = await getConfig();
    const contractAccount = config.contractAccount;
    try {
        console.log('Deploying the contract');
        // Deploys the contract bytes (requires more funding)
        const file = fs.readFileSync(wasmPath);
        const result = await contractAccount.deployContract(new Uint8Array(file));
        
        // Check transaction outcome if result is available
        if (result && result.final_execution_outcome) {
            const success = checkTransactionOutcome(result.final_execution_outcome);
            if (!success) {
                console.log(chalk.red('✗ Failed to deploy contract'));
                process.exit(1);
            }
        }
        
        await sleep(1000);
    } catch (e) {
        console.log(chalk.red(`Error deploying the custom contract from WASM: ${e.message}`));
        process.exit(1);
    }
}

function resolveWasmPath(absoluteSourcePath) {
    const cargoTomlPath = path.join(absoluteSourcePath, 'Cargo.toml');
    if (!fs.existsSync(cargoTomlPath)) {
        console.log(chalk.red(`Cargo.toml not found at ${cargoTomlPath}`));
        process.exit(1);
    }

    const cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
    const nameMatch = cargoToml.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (!nameMatch || !nameMatch[1]) {
        console.log(chalk.red('Could not find package name in Cargo.toml'));
        process.exit(1);
    }

    const crateName = nameMatch[1].replace(/-/g, '_');
    const wasmPath = path.join(absoluteSourcePath, 'target', 'near', `${crateName}.wasm`);
    if (!fs.existsSync(wasmPath)) {
        console.log(chalk.red(`WASM not found at ${wasmPath} make sure the contract build produced this file.`));
        process.exit(1);
    }

    return wasmPath;
}

// Deploy the custom contract from source
export async function deployCustomContractFromSource() {
    const config = await getConfig();
    const sourcePath = config.deployment.agent_contract.deploy_custom.source_path;
    try {
        // Resolve to absolute path for Docker volume mount
        const absoluteSourcePath = path.resolve(process.cwd(), sourcePath);
        console.log(`Building the contract from source`);

        const sudoPrefix = getSudoPrefix();
        execSync(
            `${sudoPrefix}docker run --rm -v "${absoluteSourcePath}":/workspace pivortex/near-builder@sha256:cdffded38c6cff93a046171269268f99d517237fac800f58e5ad1bcd8d6e2418 cargo near build non-reproducible-wasm --no-abi`,
            { stdio: 'pipe' }
        );

        const wasmPath = resolveWasmPath(absoluteSourcePath);
        
        // Fix file ownership after Docker creates it (Docker runs as root, files owned by root)
        if (process.platform === 'linux') {
            const uid = process.getuid();
            const gid = process.getgid();
            execSync(`${sudoPrefix}chown ${uid}:${gid} "${wasmPath}"`, { stdio: 'pipe' });
        }
        
        await innerDeployCustomContractFromWasm(wasmPath);
    } catch (e) {
        console.log(chalk.red(`Error building/deploying the custom contract from source: ${e.message}`));
        process.exit(1);
    }
}

// Deploy the custom contract using a global hash
export async function deployCustomContractFromGlobalHash() {
    const config = await getConfig();
    const globalHash = config.deployment.agent_contract.deploy_custom.global_hash;
    const contractAccount = config.contractAccount;
    
    try {
        console.log(`Deploying the contract using global hash: ${globalHash}`);
        
        // Decode the base58-encoded hash to get the codeHash bytes
        const codeHash = bs58.decode(globalHash);
        
        // Deploy using the global contract
        const result = await contractAccount.useGlobalContract({
            codeHash: codeHash,
        });
        
        // Check transaction outcome if result is available
        if (result && result.final_execution_outcome) {
            const success = checkTransactionOutcome(result.final_execution_outcome);
            if (!success) {
                console.log(chalk.red('✗ Failed to deploy contract from global hash'));
                process.exit(1);
            }
        }
        
        await sleep(1000);
    } catch (e) {
        console.log(chalk.red(`Error deploying the custom contract from global hash: ${e.message}`));
        process.exit(1);
    }
}

// Initialize the contract
export async function initContract() {
    const config = await getConfig();
    const contractAccount = config.contractAccount;
    const contractId = config.deployment.agent_contract.contract_id;
    // Initializes the contract based on deployment config
    console.log('Initializing the contract');
    try {
        const initCfg = config.deployment.agent_contract.deploy_custom.init;

        const methodName = initCfg.method_name;

        // Resolve deployment placeholders in args
        const replacements = {};
        replacements['<MASTER_ACCOUNT_ID>'] = config.masterAccount.accountId;
        replacements['<DEFAULT_MPC_CONTRACT_ID>'] = config.deployment.network === 'mainnet' ? 'v1.signer' : 'v1.signer-prod.testnet';
        replacements['<REQUIRES_TEE>'] = config.deployment.environment === 'TEE';
        const args = replacePlaceholders(initCfg.args, replacements);

        const result = await contractAccount.callFunctionRaw({
            contractId,
            methodName,
            args,
            gas: tgasToGas(initCfg.tgas),
        });
        
        // Check transaction outcome if result is available
        if (result && result.final_execution_outcome) {
            const success = checkTransactionOutcome(result.final_execution_outcome);
            if (!success) {
                console.log(chalk.red('✗ Failed to initialize contract'));
                process.exit(1);
            }
        }
        
        await sleep(1000);
    } catch (e) {
        console.log(chalk.red(`Error initializing the contract: ${e.message}`));
        process.exit(1);
    }
}

// Delete the contract key
export async function deleteContractKey() {
    const config = await getConfig();
    const contractAccount = config.contractAccount;
    const masterAccount = config.masterAccount;
    
    // Get the master account's public key (the same key used to create the contract account)
    const publicKey = await masterAccount.getSigner().getPublicKey();
    
    try {
        console.log('Deleting contract key to lock the account');
        const result = await contractAccount.deleteKey(publicKey);
        
        // Check transaction outcome if result is available
        if (result && result.final_execution_outcome) {
            const success = checkTransactionOutcome(result.final_execution_outcome);
            if (!success) {
                console.log(chalk.red('✗ Failed to delete contract key'));
                process.exit(1);
            }
        }
        
        await sleep(1000);
    } catch (e) {
        console.log(chalk.red(`Error deleting contract key: ${e.message}`));
        process.exit(1);
    }
}

// Approve the specified measurements based on deployment config
export async function approveMeasurements() {
    const config = await getConfig();
    const masterAccount = config.masterAccount;
    const contractId = config.deployment.agent_contract.contract_id;
    // Approves the specified measurements based on deployment config
    console.log('Approving the measurements');
    try {
        const approveCfg = config.deployment.approve_measurements;

        // Resolve measurements placeholder in args
        const replacements = {};
        const measurements = getMeasurements(config.deployment.environment === 'TEE', config.deployment.docker_compose_path);
        // Pass the object directly, replacePlaceholders will handle JSON stringification
        replacements['<MEASUREMENTS>'] = measurements;
        
        const args = replacePlaceholders(approveCfg.args, replacements);

        const result = await masterAccount.callFunctionRaw({
            contractId,
            methodName: approveCfg.method_name,
            args,
            gas: tgasToGas(approveCfg.tgas),
        });
        
        // Check transaction outcome if result is available
        if (result && result.final_execution_outcome) {
            const success = checkTransactionOutcome(result.final_execution_outcome);
            if (!success) {
                console.log(chalk.red('✗ Failed to approve measurements'));
                process.exit(1);
            }
        }
        
        await sleep(1000);
    } catch (e) {
        console.log(chalk.red(`Error approving the measurements: ${e.message}`));
        process.exit(1);
    }
}

