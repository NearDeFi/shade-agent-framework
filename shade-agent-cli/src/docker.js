import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { platform } from 'os';
import { config } from './config.js';

function needsSudo() {
    const platformName = platform();
    return platformName === 'linux';
}

// Safely update the docker-compose image using YAML parsing
export async function replaceInYaml(dockerTag, codehash) {
    console.log('Replacing the codehash in the yaml file');
    try {
        const path = config.deployment.build_docker_image.docker_compose_path;
        const compose = readFileSync(path, 'utf8');
        const { parse, stringify } = await import('yaml');
        const doc = parse(compose);

        if (!doc.services || !doc.services['shade-agent-app']) {
            throw new Error(`Could not find services.shade-agent-app in ${path}`);
        }

        // Set image to tag@digest
        doc.services['shade-agent-app'].image = `${dockerTag}@sha256:${codehash}`;

        const updated = stringify(doc);
        writeFileSync(path, updated, 'utf8');
    } catch (e) {
        console.log('Error replacing codehash in the yaml file', e);
        process.exit(1);
    }
}

export async function buildImage(dockerTag) {
    // Builds the image
    console.log('Building the Docker image');
    try {
        const cacheFlag = config.deployment.build_docker_image.cache === false ? '--no-cache' : '';
        const dockerCmd = needsSudo() ? 'sudo docker' : 'docker';
        execSync(`${dockerCmd} build ${cacheFlag} --platform=linux/amd64 -t ${dockerTag}:latest .`, { stdio: 'pipe' });
    } catch (e) {
        console.log('Error building the Docker image', e);
        process.exit(1);
    }
}

export async function pushImage(dockerTag) {
    // Pushes the image to docker hub
    console.log('Pushing the Docker image');
    try {
        const dockerCmd = needsSudo() ? 'sudo docker' : 'docker';
        const output = execSync(
            `${dockerCmd} push ${dockerTag}`,
            { encoding: 'utf-8', stdio: 'pipe' }
        );
        const match = output.toString().match(/sha256:[a-f0-9]{64}/gim);
        if (!match || !match[0]) {
            console.log('Error: Could not extract codehash from the Docker push output');
            process.exit(1);
        }
        const newAppCodehash = match[0].split('sha256:')[1];
        return newAppCodehash;
    } catch (e) {
        console.log('Error pushing the Docker image', e);
        process.exit(1);
    }
}

export async function dockerImage() {
    const dockerTag = config.deployment.build_docker_image.tag;
    // Builds the image
    await buildImage(dockerTag);

    // Pushes the image and gets the new codehash
    const newAppCodehash = await pushImage(dockerTag);

    // Replaces the codehash in the yaml file
    await replaceInYaml(dockerTag, newAppCodehash);

    return newAppCodehash;
}