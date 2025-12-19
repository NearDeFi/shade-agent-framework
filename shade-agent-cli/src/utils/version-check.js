import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import chalk from 'chalk';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get current version from package.json
function getCurrentVersion() {
    try {
        const packagePath = join(__dirname, '..', '..', 'package.json');
        const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
        return packageJson.version;
    } catch (error) {
        console.log('Error reading package.json:', error.message);
        return null;
    }
}

// Check for updates by fetching from npm registry
async function checkForUpdates() {
    const currentVersion = getCurrentVersion();

    try {
        const response = await fetch('https://registry.npmjs.org/@neardefi/shade-agent-cli/latest');
        if (!response.ok) {
            console.log('Failed to check for version updates');
            return null;
        }
        
        const data = await response.json();
        const latestVersion = data.version;
        
        return {
            current: currentVersion,
            latest: latestVersion,
            hasUpdate: latestVersion !== currentVersion
        };
    } catch (error) {
        console.log('Failed to check for version updates');
        return null;
    }
}

// Check for updates and display if available
export async function versionCheck() {
    const updateInfo = await checkForUpdates();
    if (!updateInfo) {
        return;
    }
    
    if (updateInfo.hasUpdate) {
        console.log(`\n${chalk.yellow('📦')} ${chalk.cyan('Update available:')} ${chalk.red(updateInfo.current)} ${chalk.gray('→')} ${chalk.green(updateInfo.latest)}`);
        console.log(`   ${chalk.blue('Run:')} ${chalk.white('npm update -g @neardefi/shade-agent-cli')}\n`);
        await sleep(5000);
    } 
}

