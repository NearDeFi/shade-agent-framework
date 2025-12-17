import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
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
function wrapText(text, maxWidth = 70) {
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';
    
    for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        if (testLine.length <= maxWidth) {
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
    
    return lines;
}

// Log wrapped text
function logWrapped(text, maxWidth = 70) {
    const lines = wrapText(text, maxWidth);
    lines.forEach(line => console.log(line));
}

export function planCommand() {
    const cmd = new Command('plan');
    cmd.description('Show what would happen when deploying (dry-run)');
    
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
            console.log('\n' + '═'.repeat(70));
            console.log('🔎 DEPLOYMENT PLAN');
            console.log('═'.repeat(70) + '\n');
            
            // 1. Docker Image (if TEE and enabled)
            if (deployment.environment === 'TEE' && deployment.build_docker_image) {
                const cacheText = deployment.build_docker_image.cache ? 'with' : 'without';
                console.log('🐳 Docker Image');
                console.log('─'.repeat(70));
                console.log('');
                logWrapped(`A docker image for your agent will be built according to the ${deployment.build_docker_image.dockerfile_path} file, ${cacheText} caching and published to ${deployment.build_docker_image.tag}.`);
                console.log('');
                logWrapped(`The docker image hash will be updated in your ${deployment.docker_compose_path} file.`);
                console.log('');
                console.log('');
            }
            
            // 2. Contract Deployment
            if (deployment.agent_contract.deploy_custom) {
                console.log('📜 Agent Contract Deployment');
                console.log('─'.repeat(70));
                console.log('');
                
                const contractId = deployment.agent_contract.contract_id;
                const network = deployment.network;
                const fundingAmount = deployment.agent_contract.deploy_custom.funding_amount;
                
                let fundingLine = `with a balance of ${fundingAmount} NEAR`;
                if (accountId) {
                    fundingLine += `, funded from your master account ${accountId}`;
                } else {
                    fundingLine += `, funded from your master account`;
                }
                fundingLine += '.';
                
                logWrapped(`The contract account ${contractId} will be created on ${network} ${fundingLine}`);
                logWrapped(`If the contract account already exists it will be cleared of its existing contract.`);
                console.log('');
                
                // Deploy from source or WASM
                if (deployment.agent_contract.deploy_custom.source_path) {
                    const sourcePath = deployment.agent_contract.deploy_custom.source_path;
                    logWrapped(`The agent contract in the ${sourcePath} directory will be compiled then deployed to ${contractId} on ${network}.`);
                } else if (deployment.agent_contract.deploy_custom.wasm_path) {
                    const wasmPath = deployment.agent_contract.deploy_custom.wasm_path;
                    logWrapped(`The agent contract contained within the wasm file ${wasmPath} will be deployed to ${contractId} on ${network}.`);
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
                    
                    logWrapped(`The agent contract will be initialized via the ${initCfg.method_name} method with arguments:`);
                    console.log(formatArgs(resolvedArgs));
                    if (!accountId) {
                        console.log('');
                        logWrapped('Note: <MASTER_ACCOUNT_ID> will be filled out with the master account once it is set.');
                    }
                    console.log('');
                } else {
                    logWrapped('The agent contract won\'t be initialized.');
                    console.log('');
                }
                
                // Contract locking status
                if (deployment.agent_contract.deploy_custom.delete_key) {
                    logWrapped('The contract account will be locked (access key deleted) after deployment.');
                } else {
                    logWrapped('The contract account will not be locked.');
                }
                console.log('');
            } else {
                console.log('📜 Agent Contract Deployment');
                console.log('─'.repeat(70));
                console.log('');
                const contractId = deployment.agent_contract.contract_id;
                const network = deployment.network;
                logWrapped(`An existing agent contract deployed at ${contractId} on ${network} will be used. You should check that the agent contract is configured for the desired environment (local or TEE).`);
                console.log('');
            }
            
            // 3. Approve Codehash
            if (deployment.approve_codehash) {
                console.log('✅ Codehash Approval');
                console.log('─'.repeat(70));
                console.log('');
                
                const approveCfg = deployment.approve_codehash;
                
                // Handle codehash message
                if (deployment.environment === 'TEE') {
                    if (deployment.build_docker_image) {
                        logWrapped(`The <CODEHASH> will be replaced by the one computed when the docker image is published.`);
                        console.log('');
                    } else {
                        const composePath = path.resolve(deployment.docker_compose_path);
                        logWrapped(`It will approve the codehash in your current ${deployment.docker_compose_path} file.`);
                        console.log('');
                    }
                }
                
                const resolvedArgs = resolvePlaceholders(
                    approveCfg.args,
                    accountId,
                    deployment.network,
                    deployment.environment,
                    codehash
                );
                
                logWrapped(`The ${approveCfg.method_name} method on the agent contract will be called with arguments:`);
                console.log(formatArgs(resolvedArgs));
                console.log('');
            } else {
                console.log('✅ Codehash Approval');
                console.log('─'.repeat(70));
                console.log('');
                console.log('The codehash won\'t be approved.\n');
            }
            
            // 4. Phala Deployment
            if (deployment.deploy_to_phala && deployment.environment === 'TEE') {
                console.log('☁️  Phala Cloud Deployment');
                console.log('─'.repeat(70));
                console.log('');
                
                const dockerStatus = deployment.build_docker_image ? 'new' : 'existing';
                logWrapped(`The ${dockerStatus} docker image will be published to Phala Cloud with the name ${deployment.deploy_to_phala.app_name} and the environment variables contained within ${deployment.deploy_to_phala.env_file_path}.`);
                console.log('');
            }
            
            // 5. Credentials Check
            console.log('🔐 Required Credentials Status');
            console.log('─'.repeat(70));
            console.log('');
            
            const missingCredentials = [];
            
            if (!credentials) {
                missingCredentials.push(`${deployment.network} master account`);
            } else {
                console.log(`✓ ${deployment.network} master account: ${accountId}`);
            }
            
            if (deployment.environment === 'TEE' && deployment.deploy_to_phala && !phalaKey) {
                missingCredentials.push('PHALA API key');
            } else if (deployment.environment === 'TEE' && deployment.deploy_to_phala) {
                console.log('✓ PHALA API key: configured');
            }
            
            if (missingCredentials.length > 0) {
                console.log('⚠️  Missing Credentials:');
                missingCredentials.forEach(cred => {
                    console.log(`   - ${cred}`);
                });
                console.log('');
                logWrapped('Please run "shade auth set" to configure missing credentials.');
            }
            
            console.log('');            
        } catch (error) {
            console.error('❌ Error generating plan:', error.message);
            if (error.stack) {
                console.error(error.stack);
            }
            process.exit(1);
        }
    });
    
    return cmd;
}
