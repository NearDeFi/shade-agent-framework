import { Command } from 'commander';
import { dockerImage } from './docker.js';
import { createAccount, deployCustomContractFromSource, deployCustomContractFromWasm, initContract, approveCodehash, deleteContractKey } from './near.js';
import { deployPhalaWorkflow, getAppUrl } from './phala.js';
import { getConfig } from '../../utils/config.js';

export function deployCommand() {
    const cmd = new Command('deploy');
    cmd.description('Deploy a Shade agent');
    
    cmd.action(async () => {
        try {
            // Load config at the start of deploy
            const config = await getConfig();
        
        if (config.deployment.environment === 'TEE' && config.deployment.build_docker_image) {
            await dockerImage();
        }
        if (config.deployment.agent_contract.deploy_custom) {
            await createAccount();

            if (config.deployment.agent_contract.deploy_custom.source_path) {
                await deployCustomContractFromSource();
            }

            if (config.deployment.agent_contract.deploy_custom.wasm_path) {
                await deployCustomContractFromWasm();
            }

            if (config.deployment.agent_contract.deploy_custom.init) {
                await initContract();
            }

            if (config.deployment.agent_contract.deploy_custom.delete_key) {
                await deleteContractKey();
            }
        }

        if (config.deployment.approve_codehash) {
            await approveCodehash();
        }

        if (config.deployment.deploy_to_phala && config.deployment.environment === 'TEE') {
            const appId = await deployPhalaWorkflow();
            await getAppUrl(appId);
        }
        
        console.log('\n✅ Deployment completed successfully!');
        } catch (error) {
            console.error('❌ Error during deployment:', error.message);
            if (error.stack) {
                console.error(error.stack);
            }
            process.exit(1);
        }
    });
    
    return cmd;
}

