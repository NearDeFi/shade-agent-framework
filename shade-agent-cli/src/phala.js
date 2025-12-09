import { execSync } from 'child_process';
import { config } from './config.js';

// Use native fetch if available, otherwise require node-fetch
/** @type {(input: any, init?: any) => Promise<any>} */
let fetchFn;
if (typeof fetch === 'function') {
    fetchFn = fetch;
} else {
    fetchFn = (input, init) => import('node-fetch').then(({ default: fetch }) => fetch(input, init));
}

// Use the specific phala version
const PHALA_VERSION = '1.0.35';
const PHALA_COMMAND = `npx phala@${PHALA_VERSION}`;

function loginToPhala(phalaKey) {
    // Logs in to Phala Cloud
    console.log('logging in to Phala Cloud...');
    try {
        execSync(`${PHALA_COMMAND} auth login ${phalaKey}`);
        console.log('Successfully logged in to Phala Cloud');
        return true;
    } catch (e) {
        console.log('Error authenticating with Phala Cloud', e);
        return false;
    }
}

function deployToPhala(dockerTag) {
    // Deploys the app to Phala Cloud using phala CLI
    console.log('deploying to Phala Cloud...');
    const appNameSplit = dockerTag.split('/');
    const appName = appNameSplit[appNameSplit.length - 1];
    
    // Validate app name length
    if (appName.length <= 3) {
        console.log('Error: Docker tag app name must be longer than 3 characters');
        return null;
    }
    
    try {
        const composePath = config.deployment?.deploy_to_phala?.docker_compose_path;
        const envFilePath = config.deployment?.deploy_to_phala?.env_file_path;

        if (!composePath || !envFilePath) {
            throw new Error('deploy_to_phala.docker_compose_path and env_file_path are required in deployment config');
        }

        const result = execSync(
            `${PHALA_COMMAND} cvms create --name ${appName} --vcpu 1 --compose ${composePath} --env-file ${envFilePath}`,
            { encoding: 'utf-8' }
        );
        console.log('deployed to Phala Cloud');

        const deploymentUrlMatch = result.match(/App URL\s*│\s*(https:\/\/[^\s]+)/);
        if (deploymentUrlMatch) {
            const deploymentUrl = deploymentUrlMatch[1];
            console.log(`\n You can find your deployment at: ${deploymentUrl}`);
        }
        
        // Extract App ID from the output 
        const appId = result.match(/App ID\s*│\s*(app_[a-f0-9]+)/);
        if (appId) {
            return appId[1];
        } else {
            console.log('Could not extract App ID from output');
            return null;
        }
    } catch (e) {
        console.log('Error deploying to Phala Cloud', e);
        return null;
    }
}

export async function getAppUrl(appId, phalaKey) {
    console.log('Getting app url...');
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
                // Find the app url with port 3000
                if (Array.isArray(data.public_urls)) {
                    const url3000 = data.public_urls.find(u => u.app && u.app.includes('-3000.'));
                    if (url3000 && url3000.app) {
                        console.log(`\n🎉 Your app is live at: ${url3000.app}`);
                        return url3000.app;
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
    console.error(`CVM Network Info did not become ready after ${maxAttempts} attempts.`);
    return null;
}

export async function deployPhalaWorkflow(phalaKey, dockerTag) {
    // Logs in to Phala Cloud
    if (!loginToPhala(phalaKey)) {
        return false;
    }

    // Deploys the app to Phala Cloud
    const appId = deployToPhala(dockerTag);

    if (!appId) {
        return false;
    }

    return appId;
}