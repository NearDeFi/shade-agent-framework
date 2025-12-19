import { Command } from 'commander';
import chalk from 'chalk';
import input from '@inquirer/input';
import { getConfig, getDeploymentConfig } from '../../utils/config.js';
import { getCredentialsOptional } from '../../utils/config.js';
import { replacePlaceholder } from '../../utils/placeholders.js';
import { isExitPromptError } from '../../utils/error-handler.js';

function tgasToGas(tgas) {
    return BigInt(tgas) * BigInt(1000000000000);
}

export function whitelistCommand() {
    const cmd = new Command('whitelist');
    cmd.description('Whitelist an agent account');
    
    // Handle errors for invalid arguments
    cmd.configureOutput({
        writeErr: (str) => {
            if (str.includes('too many arguments') || str.includes('unknown option')) {
                console.error(chalk.red(`Error: No more arguments are required after 'whitelist'.`));
                process.exit(1);
            } else {
                process.stderr.write(str);
            }
        }
    });
    
    cmd.action(async () => {
        try {
            // Load deployment config first to check if whitelist_agent is configured
            const deployment = getDeploymentConfig();
            
            if (!deployment.whitelist_agent) {
                console.error(chalk.red('Error: whitelist_agent is not configured in deployment.yaml'));
                console.error(chalk.yellow('Please add a whitelist_agent section to your deployment.yaml file.'));
                process.exit(1);
            }
            
            // Check if master account is set
            const credentials = await getCredentialsOptional(deployment.network);
            if (!credentials) {
                console.error(chalk.red(`Error: No master account found for ${deployment.network} network.`));
                console.error(chalk.yellow('Please run "shade auth set" to set master account.'));
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
            const resolvedArgs = agentAccountId 
                ? replacePlaceholder(whitelistCfg.args, '<AGENT_ACCOUNT_ID>', agentAccountId)
                : whitelistCfg.args;
            
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
                console.error(chalk.red(`\nError whitelisting agent account: ${e.message}`));
                if (e.type) {
                    console.error(chalk.yellow(`Error type: ${e.type}`));
                }
                process.exit(1);
            }
            
        } catch (error) {
            // ExitPromptError is handled globally in cli.js
            if (isExitPromptError(error)) {
                process.exit(0);
            }
            console.error(chalk.red(`Error: ${error.message}`));
            if (error.stack) {
                console.error(error.stack);
            }
            process.exit(1);
        }
    });
    
    return cmd;
}

