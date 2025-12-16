import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { config } from './config.js';

// Use native fetch if available, otherwise require node-fetch
/** @type {(input: any, init?: any) => Promise<any>} */
let fetchFn;
if (typeof fetch === 'function') {
    fetchFn = fetch;
} else {
    fetchFn = (input, init) => import('node-fetch').then(({ default: fetch }) => fetch(input, init));
}

// Resolve the locally installed phala binary (installed via npm)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function getPhalaBin() {
    // When CLI is installed globally or locally, phala should be in the CLI package's node_modules
    // __dirname is src/, so go up one level to the package root, then to node_modules/.bin
    const cliBin = path.resolve(__dirname, '..', 'node_modules', '.bin', 'phala');
    if (fs.existsSync(cliBin)) return cliBin;
    
    // If not found in .bin, try to find the phala package and get its bin from package.json
    const phalaPkgPath = path.resolve(__dirname, '..', 'node_modules', 'phala');
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
    
    console.log('phala binary not found. Make sure phala@1.0.35 is installed with @neardefi/shade-agent-cli.');
    process.exit(1);
}
const PHALA_COMMAND = getPhalaBin();

function getAppNameFromDeployment() {
    const appName = config.deployment?.deploy_to_phala?.app_name;
    if (!appName || typeof appName !== 'string') {
        console.log('deploy_to_phala.app_name is required in deployment.yaml');
        process.exit(1);
    }
    return appName;
}

function loginToPhala() {
    const phalaKey = config.phalaKey;

    // Logs in to Phala Cloud
    console.log('Logging in to Phala Cloud');
    try {
        execSync(`${PHALA_COMMAND} auth login ${phalaKey}`, { stdio: 'pipe' });
        console.log('Successfully logged in to Phala Cloud');
    } catch (e) {
        console.log('Error authenticating with Phala Cloud', e);
        process.exit(1);
    }
}

function deployToPhala() {
    // Deploys the app to Phala Cloud using phala CLI
    console.log('Deploying to Phala Cloud');
    const appName = getAppNameFromDeployment();
    
    // Validate app name length
    if (appName.length <= 3) {
        console.log('Error: Docker tag app name must be longer than 3 characters');
        process.exit(1);
    }
    
    try {
        const composePath = config.deployment?.deploy_to_phala?.docker_compose_path;
        const envFilePath = config.deployment?.deploy_to_phala?.env_file_path;

        const result = execSync(
            `${PHALA_COMMAND} cvms create --name ${appName} --vcpu 1 --compose ${composePath} --env-file ${envFilePath}`,
            { encoding: 'utf-8', stdio: 'pipe' }
        );

        const deploymentUrlMatch = result.match(/App URL\s*│\s*(https:\/\/[^\s]+)/);
        if (deploymentUrlMatch) {
            const deploymentUrl = deploymentUrlMatch[1];
            console.log(`\n Phala Application Dashboard URL: ${deploymentUrl}`);
        }
        
        // Extract App ID from the output 
        const appId = result.match(/App ID\s*│\s*(app_[a-f0-9]+)/);
        if (appId) {
            return appId[1];
        } else {
            console.log('Could not extract App ID from output');
            process.exit(1);
        }
    } catch (e) {
        console.log('Error deploying to Phala Cloud', e);
        process.exit(1);
    }
}

// They might not use port 3000, this should be dynamic

export async function getAppUrl(appId) {
    const phalaKey = config.phalaKey;
    console.log('Getting the app URL');
    const url = `https://cloud-api.phala.network/api/v1/cvms/${appId}`;
    const maxAttempts = 30;
    const delay = 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await fetchFn(url, { headers: { 'X-API-Key': phalaKey } });
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            if (!data.error) {
                // List all non-empty public URLs
                if (Array.isArray(data.public_urls)) {
                    const validUrls = data.public_urls.filter(u => u.app && u.app.trim() !== '');
                    if (validUrls.length > 0) {
                        console.log(`\n Your app is live at:`);
                        validUrls.forEach((urlObj, index) => {
                            console.log(`  ${index + 1}. ${urlObj.app}${urlObj.instance ? ` (instance: ${urlObj.instance})` : ''}`);
                        });
                        // Return the first URL for backwards compatibility
                        return validUrls[0].app;
                    }
                }
            }
        } catch (e) {
            console.error(`Error fetching CVM network info (attempt ${attempt}):`, e);
        }
        if (attempt < maxAttempts) {
            await new Promise(res => setTimeout(res, delay));
        }
    }
    console.error(`Failed to get app URL: CVM Network Info did not become ready after ${maxAttempts} attempts.`);
    return null;
}

export async function deployPhalaWorkflow() {
    // Logs in to Phala Cloud
    loginToPhala();

    // Deploys the app to Phala Cloud
    const appId = deployToPhala();

    return appId;
}