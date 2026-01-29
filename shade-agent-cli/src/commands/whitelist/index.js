import { Command } from 'commander';
import chalk from 'chalk';
import input from '@inquirer/input';
import { getConfig, getDeploymentConfig } from '../../utils/config.js';
import { getNearCredentialsOptional } from '../../utils/config.js';
import { replacePlaceholders } from '../../utils/placeholders.js';
import { isExitPromptError, createCommandErrorHandler } from '../../utils/error-handler.js';
import { tgasToGas } from '../../utils/near.js';
import { checkTransactionOutcome } from '../../utils/transaction-outcome.js';

export function whitelistCommand() {
    const cmd = new Command('whitelist');
    cmd.description('Whitelist an agent for local environment (whitelist_agent_for_local)');
    
    // Handle errors for invalid arguments
    cmd.configureOutput(createCommandErrorHandler('whitelist', { maxArgs: 0 }));
    
    cmd.action(async () => {
        try {
            // Load deployment config first to check if whitelist_agent_for_local is configured
            const deployment = getDeploymentConfig();
            
            if (deployment.environment !== 'local') {
                console.error(chalk.red('Error: whitelist_agent_for_local is only valid when environment is local.'));
                console.error(chalk.red(`Current environment is: ${deployment.environment}`));
                process.exit(1);
            }
            
            if (!deployment.whitelist_agent_for_local) {
                console.error(chalk.red('Error: whitelist_agent_for_local is not configured in deployment.yaml'));
                console.error(chalk.yellow('Please add a whitelist_agent_for_local section to your deployment.yaml file.'));
                process.exit(1);
            }
            
            // Check if master account is set
            const credentials = await getNearCredentialsOptional(deployment.network);
            if (!credentials) {
                console.log(chalk.red(`Error: No master account found for ${deployment.network} network.`));
                console.log(chalk.yellow('Please run "shade auth set" to set master account.'));
                process.exit(1);
            }
            
            // Get full config (requires credentials)
            const config = await getConfig();
            
            const whitelistCfg = deployment.whitelist_agent_for_local;
            const contractId = deployment.agent_contract.contract_id;
            
            // Check if <AGENT_ACCOUNT_ID> placeholder is in args
            const argsStr = typeof whitelistCfg.args === 'string' ? whitelistCfg.args : JSON.stringify(whitelistCfg.args);
            const needsAgentId = argsStr.includes('<AGENT_ACCOUNT_ID>');
            
            let agentAccountId = null;
            if (needsAgentId) {
                agentAccountId = await input({
                    message: 'Enter agent account ID to whitelist for local:',
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
                ? replacePlaceholders(whitelistCfg.args, { '<AGENT_ACCOUNT_ID>': agentAccountId })
                : whitelistCfg.args;
            
            if (agentAccountId) {
                console.log(`\nWhitelisting agent for local: ${agentAccountId}`);
            } else {
                console.log(`\nWhitelisting agent for local...`);
            }
            console.log(`Calling ${whitelistCfg.method_name} on ${contractId}`);
            console.log(`Arguments: ${JSON.stringify(resolvedArgs, null, 2)}`);
            
            // Make the contract call
            try {
                const result = await config.masterAccount.callFunctionRaw({
                    contractId,
                    methodName: whitelistCfg.method_name,
                    args: resolvedArgs,
                    gas: tgasToGas(whitelistCfg.tgas),
                });
                
                // Check transaction outcome if result is available
                if (result && result.final_execution_outcome) {
                    const success = checkTransactionOutcome(result.final_execution_outcome);
                    if (!success) {
                        console.error(chalk.red(`\n✗ Failed to whitelist agent for local${agentAccountId ? `: ${agentAccountId}` : ''}`));
                        process.exit(1);
                    }
                }
                
                if (agentAccountId) {
                    console.log(chalk.green(`\n✓ Successfully whitelisted agent for local: ${agentAccountId}`));
                } else {
                    console.log(chalk.green('\n✓ Successfully whitelisted agent for local!'));
                }
            } catch (e) {
                console.error(chalk.red(`\nError whitelisting agent for local: ${e.message}`));
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

