import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import chalk from 'chalk';
import { getConfig } from '../../utils/config.js';
import { extractAllowedEnvs } from '../../utils/measurements.js';

// Use native fetch (available in Node.js 18+)
const fetchFn = globalThis.fetch;

// Resolve the locally installed phala binary (installed via npm)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get the expected phala version from package.json
function getExpectedPhalaVersion() {
    const cliPackageJsonPath = path.resolve(__dirname, '..', '..', '..', 'package.json');
    try {
        const cliPkgJson = JSON.parse(fs.readFileSync(cliPackageJsonPath, 'utf8'));
        const phalaVersion = cliPkgJson.dependencies?.phala || cliPkgJson.devDependencies?.phala;
        return phalaVersion;
    } catch (e) {
        return null;
    }
}

function getPhalaBin() {
    // Get the expected version from package.json
    const expectedVersion = getExpectedPhalaVersion();
    const cliRoot = path.resolve(__dirname, '..', '..', '..');
    const phalaPkgPath = path.resolve(cliRoot, 'node_modules', 'phala');
    
    // First, verify the phala package exists and check its version
    if (!fs.existsSync(phalaPkgPath)) {
        const versionMsg = expectedVersion ? ` (expected ${expectedVersion})` : '';
        console.log(chalk.red(`Phala package not found in node_modules${versionMsg}.`));
        process.exit(1);
    }
    
    // Verify version matches if we have an expected version
    if (expectedVersion) {
        try {
            const phalaPkgJson = JSON.parse(fs.readFileSync(path.join(phalaPkgPath, 'package.json'), 'utf8'));
            const installedVersion = phalaPkgJson.version;
            // Extract version from dependency spec (e.g., "1.0.35" from "^1.0.35" or "1.0.35")
            const expectedVersionNum = expectedVersion.replace(/^[\^~]/, '');
            
            if (installedVersion !== expectedVersionNum && !expectedVersion.startsWith('^') && !expectedVersion.startsWith('~')) {
                console.log(chalk.yellow(`Warning: Installed phala version (${installedVersion}) does not match expected version (${expectedVersionNum})`));
            }
        } catch (e) {
            // Continue if we can't read version
        }
    }
    
    // Try to find the binary in node_modules/.bin first (preferred)
    const cliBin = path.resolve(cliRoot, 'node_modules', '.bin', 'phala');
    if (fs.existsSync(cliBin)) {
        return cliBin;
    }
    
    // If not found in .bin, get the bin path from phala's package.json
    try {
        const phalaPkgJson = JSON.parse(fs.readFileSync(path.join(phalaPkgPath, 'package.json'), 'utf8'));
        const binPath = phalaPkgJson.bin?.phala || phalaPkgJson.bin?.pha;
        if (binPath) {
            const fullBinPath = path.resolve(phalaPkgPath, binPath);
            if (fs.existsSync(fullBinPath)) {
                return fullBinPath;
            }
        }
    } catch (e) {
        // Continue to error
    }
    
    const versionMsg = expectedVersion ? ` (expected ${expectedVersion})` : '';
    console.log(chalk.red(`Phala binary not found in node_modules${versionMsg}.`));
    console.log(chalk.yellow(`Make sure phala is installed: npm install`));
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

// Deploy the app to Phala Cloud
export async function deployToPhala() {
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
        const phalaKey = config.phalaKey;

        const composePath = config.deployment.docker_compose_path;
        const envFilePath = config.deployment?.deploy_to_phala?.env_file_path;

        // Extract allowed environment variables from docker-compose.yaml
        const allowedEnvs = extractAllowedEnvs(composePath);
        
        // Build environment variable flags for Phala CLI
        // Only include env vars that are allowed in docker-compose.yaml
        let envFlags = '';
        if (envFilePath && allowedEnvs.length > 0) {
            // Resolve env file path relative to current working directory (where deployment.yaml is)
            const resolvedEnvFilePath = path.isAbsolute(envFilePath) 
                ? envFilePath 
                : path.resolve(process.cwd(), envFilePath);
            
            // Read the env file and extract values for allowed env vars (allowed envs in the docker compose are decided by the ones specified in the env file not the ones defined by the docker compose file)
            if (!fs.existsSync(resolvedEnvFilePath)) {
                console.log(chalk.yellow(`Warning: Env file not found at ${resolvedEnvFilePath}, skipping environment variables`));
            } else {
                const envFileContent = fs.readFileSync(resolvedEnvFilePath, 'utf8');
                const envVars = {};
                
                // Parse .env file (simple key=value format)
                envFileContent.split('\n').forEach(line => {
                    line = line.trim();
                    // Skip comments and empty lines
                    if (line && !line.startsWith('#')) {
                        const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
                        if (match) {
                            const [, key, value] = match;
                            // Remove quotes if present (handles both single and double quotes)
                            const cleanValue = value.replace(/^["']|["']$/g, '');
                            envVars[key] = cleanValue;
                        }
                    }
                });
                
                // Build -e KEY=VALUE flags for allowed env vars only
                // Escape values that contain spaces or special characters
                const envFlagArray = allowedEnvs
                    .filter(key => envVars.hasOwnProperty(key))
                    .map(key => {
                        const value = envVars[key];
                        // Quote value if it contains spaces or special characters
                        const escapedValue = (value.includes(' ') || value.includes('$') || value.includes('`'))
                            ? `"${value.replace(/"/g, '\\"')}"`
                            : value;
                        return `-e ${key}=${escapedValue}`;
                    });
                
                if (envFlagArray.length > 0) {
                    envFlags = envFlagArray.join(' ');
                }
            }
        }

        const result = execSync(
            `${PHALA_COMMAND} deploy --name ${appName} --api-token ${phalaKey} --compose ${composePath} ${envFlags} --image dstack-0.5.5`,
            { encoding: 'utf-8', stdio: 'pipe' }
        );

        // Parse JSON response from phala deploy command
        let deployResult;
        try {
            // Extract JSON from output (may have text before/after)
            const jsonMatch = result.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                throw new Error('No JSON found in output');
            }
            deployResult = JSON.parse(jsonMatch[0]);
        } catch (e) {
            console.log(chalk.red(`Failed to parse deployment response: ${e.message}`));
            console.log(chalk.gray(`Output: ${result}`));
            process.exit(1);
        }

        // Check if deployment was successful
        if (!deployResult.success) {
            console.log(chalk.red('Deployment failed'));
            process.exit(1);
        }

        // Display dashboard URL
        if (deployResult.dashboard_url) {
            console.log(`\nPhala Application Dashboard URL: ${deployResult.dashboard_url}`);
        }

        // Return vm_uuid for API calls (getAppUrl uses it in the URL path)
        if (deployResult.vm_uuid) {
            return deployResult.vm_uuid;
        } else {
            console.log(chalk.red('Could not extract vm_uuid from deployment response'));
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
    // Deploys the app to Phala Cloud
    const appId = await deployToPhala();

    // Gets the app URL from the app ID
    await getAppUrl(appId);
}
