import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import chalk from 'chalk';
import { getDeploymentConfig, getCredentialsOptional, getPhalaKeyOptional } from '../../utils/config.js';
import { replacePlaceholders } from '../../utils/placeholders.js';

// Helper to resolve placeholders in args
function resolvePlaceholders(args, accountId, network, environment, codehash) {
    const replacements = {};
    
    if (accountId) {
        replacements['<MASTER_ACCOUNT_ID>'] = accountId;
    }
    replacements['<DEFAULT_MPC_CONTRACT_ID>'] = network === 'mainnet' ? 'v1.signer' : 'v1.signer-prod.testnet';
    replacements['<REQUIRES_TEE>'] = environment === 'TEE';
    if (codehash) {
        replacements['<CODEHASH>'] = codehash;
    }
    
    return replacePlaceholders(args, replacements);
}

// Get codehash from docker-compose file
function getCodehashFromCompose(composePath) {
    try {
        if (!existsSync(composePath)) {
            return null;
        }
        const compose = readFileSync(composePath, 'utf8');
        const doc = parseYaml(compose);
        const image = doc?.services?.['shade-agent-app']?.image;
        if (typeof image === 'string') {
            const imageMatch = image.match(/@sha256:([a-f0-9]{64})/i);
            if (imageMatch) {
                return imageMatch[1];
            }
        }
        return null;
    } catch (e) {
        return null;
    }
}

// Format JSON args nicely
function formatArgs(args) {
    return JSON.stringify(args, null, 2);
}

// Wrap text to fit within maxWidth characters
function wrapText(text, maxWidth = 70, indent = 0) {
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';
    const indentStr = ' '.repeat(indent);
    
    for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        // For wrapped lines (after first line), account for indent
        const effectiveMaxWidth = lines.length > 0 ? maxWidth - indent : maxWidth;
        if (testLine.length <= effectiveMaxWidth) {
            currentLine = testLine;
        } else {
            if (currentLine) {
                lines.push(currentLine);
            }
            // If a single word is longer than maxWidth, just use it as-is
            currentLine = word.length > maxWidth ? word : word;
        }
    }
    
    if (currentLine) {
        lines.push(currentLine);
    }
    
    // Apply indentation to wrapped lines (skip first line which has bullet)
    return lines.map((line, index) => {
        if (indent > 0 && index > 0) {
            return indentStr + line;
        }
        return line;
    });
}

// Log wrapped text
function logWrapped(text, maxWidth = 70, indent = 0) {
    const lines = wrapText(text, maxWidth, indent);
    lines.forEach(line => console.log(line));
}

export function planCommand() {
    const cmd = new Command('plan');
    cmd.description('Show what would happen when deploying (dry-run)');
    
    // Handle errors for invalid arguments
    cmd.configureOutput({
        writeErr: (str) => {
            if (str.includes('too many arguments') || str.includes('unknown option')) {
                console.error(chalk.red(`Error: No more arguments are required after 'plan'.`));
                process.exit(1);
            } else {
                process.stderr.write(str);
            }
        }
    });
    
    cmd.action(async () => {
        try {
            // Load deployment config (doesn't require credentials)
            const deployment = getDeploymentConfig();
            
            // Optionally load credentials to check if they exist and get account ID
            const credentials = await getCredentialsOptional(deployment.network);
            const accountId = credentials?.accountId || null;
            
            // Optionally load PHALA key
            const phalaKey = await getPhalaKeyOptional();
            
            // Determine codehash value
            let codehash = null;
            let codehashSource = null;
            
            if (deployment.environment === 'TEE') {
                if (deployment.build_docker_image) {
                    // Docker will be built, codehash will be computed
                    codehash = '<CODEHASH>';
                    codehashSource = 'computed';
                } else {
                    // Docker not enabled, get from existing compose file
                    const composePath = path.resolve(deployment.docker_compose_path);
                    codehash = getCodehashFromCompose(composePath);
                    codehashSource = 'existing';
                }
            } else {
                // Local environment
                codehash = 'not-in-a-tee';
                codehashSource = 'local';
            }
            
            // Start building the plan output
            console.log('\n' + chalk.cyan.bold('═'.repeat(70)));
            console.log(chalk.cyan.bold('🔎 DEPLOYMENT PLAN'));
            console.log(chalk.cyan.bold('═'.repeat(70)) + '\n');
            
            // 1. Docker Image
            console.log(chalk.cyan.bold('🐳 Docker Image'));
            console.log(chalk.gray('─'.repeat(70)));
            console.log('');
            if (deployment.environment === 'TEE') {
                if (deployment.build_docker_image) {
                    const cacheText = deployment.build_docker_image.cache ? chalk.yellow('with caching') : chalk.yellow('without caching');
                    logWrapped(`• A docker image for your agent will be built according to the ${chalk.yellow(deployment.build_docker_image.dockerfile_path)} file, ${cacheText} and published to ${chalk.yellow(deployment.build_docker_image.tag)}.`, 70, 2);
                    console.log('');
                    logWrapped(`• The docker image hash will be updated in your ${chalk.yellow(deployment.docker_compose_path)} file.`, 70, 2);
                } else {
                    logWrapped(chalk.gray('• A new docker image won\'t be built.'), 70, 2);
                }
            } else {
                logWrapped(chalk.gray('• A docker image won\'t be built because the environment is local.'), 70, 2);
            }
            console.log('');
            console.log('');
            
            // 2. Contract Deployment
            if (deployment.agent_contract.deploy_custom) {
                console.log(chalk.cyan.bold('📜 Agent Contract Deployment'));
                console.log(chalk.gray('─'.repeat(70)));
                console.log('');
                
                const contractId = deployment.agent_contract.contract_id;
                const network = deployment.network;
                const fundingAmount = deployment.agent_contract.deploy_custom.funding_amount;
                
                let fundingLine = `with a balance of ${chalk.yellow(fundingAmount + ' NEAR')}`;
                if (accountId) {
                    fundingLine += `, funded from your master account ${chalk.yellow(accountId)}`;
                } else {
                    fundingLine += `, funded from your master account`;
                }
                fundingLine += '.';
                
                logWrapped(`• The contract account ${chalk.yellow(contractId)} will be created on ${chalk.yellow(network)} ${fundingLine} If the contract account already exists it will be cleared of its existing contract.`, 70, 2);
                console.log('');
                
                // Deploy from source or WASM
                if (deployment.agent_contract.deploy_custom.source_path) {
                    const sourcePath = deployment.agent_contract.deploy_custom.source_path;
                    logWrapped(`• The agent contract in the ${chalk.yellow(sourcePath)} directory will be compiled then deployed to ${chalk.yellow(contractId)} on ${chalk.yellow(network)}.`, 70, 2);
                } else if (deployment.agent_contract.deploy_custom.wasm_path) {
                    const wasmPath = deployment.agent_contract.deploy_custom.wasm_path;
                logWrapped(`• The agent contract from the WASM file ${chalk.yellow(wasmPath)} will be deployed to the contract account ${chalk.yellow(contractId)} on ${chalk.yellow(network)}.`, 70, 2);
                }
                
                console.log('');
                
                // Initialization
                if (deployment.agent_contract.deploy_custom.init) {
                    const initCfg = deployment.agent_contract.deploy_custom.init;
                    const resolvedArgs = resolvePlaceholders(
                        initCfg.args,
                        accountId,
                        deployment.network,
                        deployment.environment,
                        codehash
                    );
                    
                    logWrapped(`• The agent contract will be initialized using the '${chalk.yellow(initCfg.method_name)}' method with arguments:`, 70, 2);
                    // Indent JSON arguments
                    const jsonLines = formatArgs(resolvedArgs).split('\n');
                    jsonLines.forEach(line => {
                        console.log('  ' + chalk.magenta(line));
                    });
                    if (!accountId) {
                        console.log('');
                        const noteMsg = `The ${chalk.magenta('<MASTER_ACCOUNT_ID>')} will be replaced once the master account is set.`;
                        const lines = wrapText(noteMsg, 70 - 2, 0);
                        lines.forEach(line => console.log('  ' + line));
                    }
                    console.log('');
                    
                    // Check if REQUIRES_TEE is in the args
                    const argsStr = typeof initCfg.args === 'string' ? initCfg.args : JSON.stringify(initCfg.args);
                    if (argsStr.includes('<REQUIRES_TEE>')) {
                        if (deployment.environment === 'TEE') {
                            logWrapped(`• The contract ${chalk.yellow('requires')} the agent to be running in a TEE.`, 70, 2);
                        } else {
                            logWrapped(`• The contract ${chalk.yellow('doesn\'t require')} the agent to be running in a TEE.`, 70, 2);
                        }
                        console.log('');
                    }
                } else {
                    logWrapped(`• The agent contract ${chalk.yellow('won\'t be initialized')}.`, 70, 2);
                    console.log('');
                }
                
                // Contract locking status
                if (deployment.agent_contract.deploy_custom.delete_key) {
                    logWrapped(`• The contract account ${chalk.yellow('will be locked')} (access key deleted) after deployment.`, 70, 2);
                } else {
                    logWrapped(`• The contract account ${chalk.yellow('won\'t be locked')}.`, 70, 2);
                }
                console.log('');
            } else {
                console.log(chalk.cyan.bold('📜 Agent Contract Deployment'));
                console.log(chalk.gray('─'.repeat(70)));
                console.log('');
                const contractId = deployment.agent_contract.contract_id;
                const network = deployment.network;
                logWrapped(`• An existing agent contract deployed at ${chalk.yellow(contractId)} on ${chalk.yellow(network)} will be used. You should check that the agent contract is configured for the desired environment (local or TEE).`, 70, 2);
                console.log('');
            }
            
            console.log('');
            // 3. Approve Codehash
            if (deployment.approve_codehash) {
                console.log(chalk.cyan.bold('✅ Codehash Approval'));
                console.log(chalk.gray('─'.repeat(70)));
                console.log('');
                
                const approveCfg = deployment.approve_codehash;
                
                const resolvedArgs = resolvePlaceholders(
                    approveCfg.args,
                    accountId,
                    deployment.network,
                    deployment.environment,
                    codehash
                );
                
                logWrapped(`• The '${chalk.yellow(approveCfg.method_name)}' method will be called on the agent contract with arguments:`, 70, 2);
                // Indent JSON arguments
                const jsonLines = formatArgs(resolvedArgs).split('\n');
                jsonLines.forEach(line => {
                    console.log('  ' + chalk.magenta(line));
                });
                
                // Add codehash message below args in same bullet point
                if (deployment.environment === 'TEE') {
                    console.log('');
                    if (deployment.build_docker_image) {
                        const codehashMsg = `The ${chalk.magenta('<CODEHASH>')} will be replaced by the computed codehash when the docker image is published.`;
                        const lines = wrapText(codehashMsg, 70 - 2, 0); // No extra indent, we'll add it manually
                        lines.forEach(line => console.log('  ' + line));
                    } else {
                        const codehashMsg = `It will approve the codehash in your current ${chalk.yellow(deployment.docker_compose_path)} file.`;
                        const lines = wrapText(codehashMsg, 70 - 2, 0); // No extra indent, we'll add it manually
                        lines.forEach(line => console.log('  ' + line));
                    }
                }
                console.log('');
                console.log('');
            } else {
                console.log(chalk.cyan.bold('✅ Codehash Approval'));
                console.log(chalk.gray('─'.repeat(70)));
                console.log('');
                    logWrapped(chalk.gray('• The codehash won\'t be approved.'), 70, 2);
                console.log('');
                console.log('');
            }
            
            // 4. Phala Deployment
            console.log(chalk.cyan.bold('☁️  Phala Cloud Deployment'));
            console.log(chalk.gray('─'.repeat(70)));
            console.log('');
            if (deployment.environment === 'TEE') {
                if (deployment.deploy_to_phala) {
                    const dockerStatus = deployment.build_docker_image ? 'new' : 'existing';
                    logWrapped(`• The ${chalk.yellow(dockerStatus)} docker image will be published to Phala Cloud with the name ${chalk.yellow(deployment.deploy_to_phala.app_name)} and the environment variables contained within ${chalk.yellow(deployment.deploy_to_phala.env_file_path)}.`, 70, 2);
                } else {
                    logWrapped(chalk.gray('• The agent won\'t be deployed to Phala Cloud.'), 70, 2);
                }
            } else {
                logWrapped(chalk.gray('• The agent won\'t be deployed to Phala Cloud because the environment is local.'), 70, 2);
            }
            console.log('');
            
            console.log('');
            // 5. Credentials Check
            console.log(chalk.cyan.bold('🔐 Required Credentials Status'));
            console.log(chalk.gray('─'.repeat(70)));
            console.log('');
            
            const missingCredentials = [];
            
            if (!credentials) {
                missingCredentials.push(`${deployment.network} master account`);
            } else {
                console.log(`✓ ${chalk.yellow(deployment.network)} master account configured: ${chalk.yellow(accountId)}`);
            }
            
            if (deployment.environment === 'TEE' && deployment.deploy_to_phala && !phalaKey) {
                missingCredentials.push('PHALA API key');
            } else if (deployment.environment === 'TEE' && deployment.deploy_to_phala) {
                console.log('✓ PHALA API key: configured');
            }
            
            if (missingCredentials.length > 0) {
                console.log(chalk.red.dim('⚠️  Missing Credentials:'));
                missingCredentials.forEach(cred => {
                    console.log(chalk.red.dim(`   - ${cred}`));
                });
                console.log('');
                logWrapped(chalk.red.dim('Please run "shade auth set" to configure missing credentials.'));
            }
            
            console.log('');
            console.log('');            
        } catch (error) {
            console.error(chalk.red(`Error generating plan: ${error.message}`));
            if (error.stack) {
                console.error(error.stack);
            }
            process.exit(1);
        }
    });
    
    return cmd;
}
