import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { parse } from 'yaml';

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

// Determine codehash value based on deployment configuration
export function getCodehashValue(deployment, composePath = null) {
    if (deployment.environment === 'TEE') {
        if (deployment.build_docker_image) {
            // Docker will be built, codehash will be computed
            return '<CODEHASH>';
        } else {
            // Docker not enabled, get from existing compose file
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

