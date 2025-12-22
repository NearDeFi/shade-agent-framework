import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { parse } from 'yaml';
import chalk from 'chalk';

// Get codehash from docker-compose file
export function getCodehashFromCompose(composePath) {
    try {
        if (!existsSync(composePath)) {
            return null;
        }
        const compose = readFileSync(composePath, 'utf8');
        const doc = parse(compose);
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

// Determine codehash value for deploy mode - always reads from compose file
export function getCodehashValueForDeploy(deployment, composePath = null) {
    if (deployment.environment === 'TEE') {
        if (composePath) {
            const resolvedPath = path.resolve(composePath);
            const codehash = getCodehashFromCompose(resolvedPath);
            if (codehash) {
                return codehash;
            }
        }
        console.log(chalk.red(`Could not find codehash for shade-agent-app in ${composePath || 'docker-compose.yaml'}`));
        process.exit(1);
    } else {
        // Local environment
        return 'not-in-a-tee';
    }
}

// Determine codehash value for plan mode - shows placeholder if build_docker_image is enabled
export function getCodehashValueForPlan(deployment, composePath = null) {
    if (deployment.environment === 'TEE') {
        if (deployment.build_docker_image) {
            // Docker will be built, codehash will be computed - show placeholder
            return '<CODEHASH>';
        } else {
            if (composePath) {
                const resolvedPath = path.resolve(composePath);
                const codehash = getCodehashFromCompose(resolvedPath);
                return codehash || '<CODEHASH>';
            }
            return '<CODEHASH>';
        }
    } else {
        // Local environment
        return 'not-in-a-tee';
    }
}


