import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import chalk from 'chalk';
import { getConfig } from '../../utils/config.js';

// Use native fetch (available in Node.js 18+)
const fetchFn = globalThis.fetch;

// Resolve the locally installed phala binary (installed via npm)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function getPhalaBin() {
    // When CLI is installed globally or locally, phala should be in the CLI package's node_modules
    // __dirname is commands/deploy/, so go up to src, then to package root, then to node_modules/.bin
    const cliBin = path.resolve(__dirname, '..', '..', '..', 'node_modules', '.bin', 'phala');
    if (fs.existsSync(cliBin)) return cliBin;
    
    // If not found in .bin, try to find the phala package and get its bin from package.json
    const phalaPkgPath = path.resolve(__dirname, '..', '..', '..', 'node_modules', 'phala');
    if (fs.existsSync(phalaPkgPath)) {
        try {
            const pkgJson = JSON.parse(fs.readFileSync(path.join(phalaPkgPath, 'package.json'), 'utf8'));
            const binPath = pkgJson.bin?.phala || pkgJson.bin?.pha;
            if (binPath) {
                const fullBinPath = path.resolve(phalaPkgPath, binPath);
                if (fs.existsSync(fullBinPath)) return fullBinPath;
            }
        } catch (e) {
            // Continue to error
        }
    }
    
    console.log(chalk.red('Phala binary not found. Make sure phala@1.0.35 is installed with @neardefi/shade-agent-cli.'));
    process.exit(1);
}
const PHALA_COMMAND = getPhalaBin();

// Get the app name from the deployment.yaml file
async function getAppNameFromDeployment() {
    const config = await getConfig();
    const appName = config.deployment?.deploy_to_phala?.app_name;
    if (!appName || typeof appName !== 'string') {
        console.log(chalk.red('deploy_to_phala.app_name is required in deployment.yaml'));
        process.exit(1);
    }
    return appName;
}

// Login to Phala Cloud
async function loginToPhala() {
    const config = await getConfig();
    const phalaKey = config.phalaKey;

    if (!phalaKey) {
        console.log(chalk.red('Error: PHALA API key is required but not found.'));
        console.log(chalk.yellow("Please run 'shade auth set' to store the PHALA API key."));
        process.exit(1);
    }

    // Logs in to Phala Cloud
    console.log('Logging in to Phala Cloud');
    try {
        execSync(`${PHALA_COMMAND} auth login ${phalaKey}`, { stdio: 'pipe' });
    } catch (e) {
        console.log(chalk.red(`Error authenticating with Phala Cloud: ${e.message}`));
        process.exit(1);
    }
}

// Deploy the app to Phala Cloud
async function deployToPhala() {
    // Deploys the app to Phala Cloud using phala CLI
    console.log('Deploying to Phala Cloud');
    const appName = await getAppNameFromDeployment();
    
    // Validate app name length
    if (appName.length <= 3) {
        console.log(chalk.red('Error: Docker tag app name must be longer than 3 characters'));
        process.exit(1);
    }
    
    try {
        const config = await getConfig();
        const composePath = config.deployment.docker_compose_path;
        const envFilePath = config.deployment?.deploy_to_phala?.env_file_path;

        const result = execSync(
            `${PHALA_COMMAND} cvms create --name ${appName} --vcpu 1 --compose ${composePath} --env-file ${envFilePath}`,
            { encoding: 'utf-8', stdio: 'pipe' }
        );

        const deploymentUrlMatch = result.match(/App URL\s*│\s*(https:\/\/[^\s]+)/);
        if (deploymentUrlMatch) {
            const deploymentUrl = deploymentUrlMatch[1];
            console.log(`\nPhala Application Dashboard URL: ${deploymentUrl}`);
        }
        
        // Extract App ID from the output 
        const appId = result.match(/App ID\s*│\s*(app_[a-f0-9]+)/);
        if (appId) {
            return appId[1];
        } else {
            console.log(chalk.red('Could not extract App ID from output'));
            process.exit(1);
        }
    } catch (e) {
        console.log(chalk.red(`Error deploying to Phala Cloud: ${e.message}`));
        process.exit(1);
    }
}

// Get the app URL from the app ID
export async function getAppUrl(appId) {
    const config = await getConfig();
    const phalaKey = config.phalaKey;
    console.log('Getting the app URL');
    const url = `https://cloud-api.phala.network/api/v1/cvms/${appId}`;
    const maxAttempts = 5;
    const delay = 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await fetchFn(url, { headers: { 'X-API-Key': phalaKey } });
            if (!response.ok) {
                if (attempt === maxAttempts) {
                    console.log(chalk.red(`HTTP error! status: ${response.status}`));
                }
                continue;
            }
            const data = await response.json();
            if (!data.error) {
                // List all non-empty public URLs
                if (Array.isArray(data.public_urls)) {
                    const validUrls = data.public_urls.filter(u => u.app && u.app.trim() !== '');
                    if (validUrls.length > 0) {
                        // Print URLs and exit immediately
                        console.log(`\nYour app is live at:`);
                        validUrls.forEach((urlObj, index) => {
                            console.log(`  ${index + 1}. ${urlObj.app}${urlObj.instance ? ` (instance: ${urlObj.instance})` : ''}`);
                        });
                        return validUrls;
                    }
                }
            }
        } catch (e) {
            if (attempt === maxAttempts) {
                console.log(chalk.red(`Error fetching CVM network info (attempt ${attempt}): ${e.message}`));
            }
        }
        if (attempt < maxAttempts) {
            await new Promise(res => setTimeout(res, delay));
        }
    }
    console.log(chalk.red(`Failed to get app URL: CVM Network Info did not become ready after ${maxAttempts} attempts.`));
    return null;
}

// Deploy to phala and get the app URL
export async function deployPhalaWorkflow() {
    // Logs in to Phala Cloud
    await loginToPhala();

    // Deploys the app to Phala Cloud
    const appId = await deployToPhala();

    // Gets the app URL from the app ID
    await getAppUrl(appId);
}
