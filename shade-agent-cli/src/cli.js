#!/usr/bin/env node
import { dockerImage } from './docker.js';
import { createAccount, deployCustomContractFromSource, deployCustomContractFromWasm, initContract, approveCodehash } from './near.js';
import { deployPhalaWorkflow, getAppUrl } from './phala.js';
import { config } from './config.js';

async function main() {
    // Version check 
    // await versionCheck();

    // Builds and pushes the docker image if in sandbox mode
    if (config.deployment.environment === 'TEE' && config.deployment.docker) {
        dockerImage(config.deployment.docker.tag, config.deployment.docker.cache === false ? '--no-cache' : '');
    }

    // Create an account for the contract
    if (config.deployment.deploy_custom) {
        const accountCreated = await createAccount(config.deployment.contract_id, config.masterAccount, config.contractAccount);
        if (!accountCreated) {
            return;
        }

        if (config.deployment.deploy_custom.path_to_contract) {
            console.log('Deploying contract from source...');
            const contractDeployed = await deployCustomContractFromSource(config.contractAccount, config.deployment.deploy_custom.path_to_contract);
            if (!contractDeployed) {
                return;
            }
        }

        if (config.deployment.deploy_custom.path_to_wasm) {
            console.log('Deploying contract from WASM...');
            const contractDeployed = await deployCustomContractFromWasm(config.contractAccount, config.deployment.deploy_custom.path_to_wasm);
            if (!contractDeployed) {
                return;
            }
        }

        if (config.deployment.deploy_custom.init) {
            const contractInitialized = await initContract(config.contractAccount, config.deployment.contract_id, config.masterAccount);
            if (!contractInitialized) {
                return;
            }
        }
    }

    // Approve the app codehash
    if (config.deployment.approve_codehash) {
    const appCodehashApproved = await approveCodehash(config.masterAccount, config.deployment.contract_id);
        if (!appCodehashApproved) {
            return;
        }
    }

    // Deploy the app to Phala Cloud
    if (config.deployment.deploy_to_phala && config.deployment.environment === 'TEE') {
        // Deploy the app to Phala Cloud
        const appId = await deployPhalaWorkflow(config.phalaKey, config.deployment.docker.tag);
        if (!appId) {
            return;
        }
        // Print the endpoint of the app
        await getAppUrl(appId, config.phalaKey)
    }
}

main();