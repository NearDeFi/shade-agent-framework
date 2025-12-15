#!/usr/bin/env node
import { dockerImage } from './docker.js';
import { createAccount, deployCustomContractFromSource, deployCustomContractFromWasm, initContract, approveCodehash } from './near.js';
import { deployPhalaWorkflow, getAppUrl } from './phala.js';
import { config } from './config.js';
import { versionCheck } from './version-check.js';

async function main() {
    await versionCheck();

    if (config.deployment.environment === 'TEE' && config.deployment.docker) {
        dockerImage();
    }
    if (config.deployment.agent_contract.deploy_custom) {
        await createAccount();

        if (config.deployment.agent_contract.deploy_custom.path_to_contract) {
            await deployCustomContractFromSource();
        }

        if (config.deployment.agent_contract.deploy_custom.path_to_wasm) {
            await deployCustomContractFromWasm();
        }

        if (config.deployment.agent_contract.deploy_custom.init) {
            await initContract();
        }
    }

    if (config.deployment.approve_codehash) {
        await approveCodehash();
    }

    if (config.deployment.deploy_to_phala && config.deployment.environment === 'TEE') {
        const appId = await deployPhalaWorkflow();
        await getAppUrl(appId);
    }
}

main();