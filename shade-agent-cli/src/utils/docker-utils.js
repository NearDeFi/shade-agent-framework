import { platform } from 'os';

// Get the sudo prefix for Docker commands based on the OS
export function getSudoPrefix() {
    const platformName = platform();
    return platformName === 'linux' ? 'sudo ' : '';
}

