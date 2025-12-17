import { Command } from 'commander';
import input from '@inquirer/input';
import { getConfig, getDeploymentConfig } from '../../utils/config.js';
import { getCredentialsOptional } from '../../utils/config.js';

// Helper to resolve placeholders in args
function resolvePlaceholders(args, agentAccountId) {
    const resolve = (val) => {
        if (typeof val === 'string') {
            if (val === '<AGENT_ACCOUNT_ID>') return agentAccountId || '<AGENT_ACCOUNT_ID>';
            return val;
        }
        if (Array.isArray(val)) return val.map(resolve);
        if (val && typeof val === 'object') {
            return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, resolve(v)]));
        }
        return val;
    };
    
    const rawArgs = typeof args === 'string' ? JSON.parse(args) : args;
    return resolve(rawArgs);
}

function tgasToGas(tgas) {
    return BigInt(tgas) * BigInt(1000000000000);
}

export function whitelistCommand() {
    const cmd = new Command('whitelist');
    cmd.description('Whitelist an agent account');
    
    cmd.action(async () => {
        try {
            // Load deployment config first to check if whitelist_agent is configured
            const deployment = getDeploymentConfig();
            
            if (!deployment.whitelist_agent) {
                console.log('❌ Error: whitelist_agent is not configured in deployment.yaml');
                console.log('Please add a whitelist_agent section to your deployment.yaml file.');
                process.exit(1);
            }
            
            // Check if master account is set
            const credentials = await getCredentialsOptional(deployment.network);
            if (!credentials) {
                console.log(`❌ Error: No master account found for ${deployment.network} network.`);
                console.log('Please run "shade auth set" to set master account.');
                process.exit(1);
            }
            
            // Get full config (requires credentials)
            const config = await getConfig();
            
            const whitelistCfg = deployment.whitelist_agent;
            const contractId = deployment.agent_contract.contract_id;
            
            // Check if <AGENT_ACCOUNT_ID> placeholder is in args
            const argsStr = typeof whitelistCfg.args === 'string' ? whitelistCfg.args : JSON.stringify(whitelistCfg.args);
            const needsAgentId = argsStr.includes('<AGENT_ACCOUNT_ID>');
            
            let agentAccountId = null;
            if (needsAgentId) {
                agentAccountId = await input({
                    message: 'Enter agent account ID to whitelist:',
                    validate: (value) => {
                        if (!value || value.trim().length === 0) {
                            return 'Agent account ID is required';
                        }
                        return true;
                    },
                });
            }
            
            // Resolve placeholders in args
            const resolvedArgs = resolvePlaceholders(whitelistCfg.args, agentAccountId);
            
            if (agentAccountId) {
                console.log(`\nWhitelisting agent account: ${agentAccountId}`);
            } else {
                console.log(`\nWhitelisting agent account...`);
            }
            console.log(`Calling ${whitelistCfg.method_name} on ${contractId}`);
            console.log(`Arguments: ${JSON.stringify(resolvedArgs, null, 2)}`);
            
            // Make the contract call
            try {
                await config.masterAccount.callFunctionRaw({
                    contractId,
                    methodName: whitelistCfg.method_name,
                    args: resolvedArgs,
                    gas: tgasToGas(whitelistCfg.tgas),
                });
                
                if (agentAccountId) {
                    console.log(`\n✅ Successfully whitelisted agent account: ${agentAccountId}`);
                } else {
                    console.log('\n✅ Successfully whitelisted agent account!');
                }
            } catch (e) {
                console.error('\n❌ Error whitelisting agent account:', e.message);
                if (e.type) {
                    console.error(`Error type: ${e.type}`);
                }
                process.exit(1);
            }
            
        } catch (error) {
            console.error('❌ Error:', error.message);
            if (error.stack) {
                console.error(error.stack);
            }
            process.exit(1);
        }
    });
    
    return cmd;
}

