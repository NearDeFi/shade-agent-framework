import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { platform } from 'os';
import { parse, stringify } from 'yaml';
import chalk from 'chalk';
import { getConfig } from '../../utils/config.js';

function needsSudo() {
    const platformName = platform();
    return platformName === 'linux';
}

// Update the docker-compose image in the docker-compose file
export async function replaceInYaml(dockerTag, codehash) {
    console.log('Replacing the codehash in the yaml file');
    try {
        const config = await getConfig();
        const path = config.deployment.docker_compose_path;
        const compose = readFileSync(path, 'utf8');
        const doc = parse(compose);

        if (!doc.services || !doc.services['shade-agent-app']) {
            console.log(chalk.red(`Could not find services.shade-agent-app in ${path}`));
            process.exit(1);
        }

        // Set image to tag@sha256:codehash
        doc.services['shade-agent-app'].image = `${dockerTag}@sha256:${codehash}`;

        const updated = stringify(doc);
        writeFileSync(path, updated, 'utf8');
    } catch (e) {
        console.log(chalk.red(`Error replacing codehash in the yaml file: ${e.message}`));
        process.exit(1);
    }
}

// Build the Docker image
export async function buildImage(dockerTag) {
    console.log('Building the Docker image');
    try {
        const config = await getConfig();
        const cacheFlag = config.deployment.build_docker_image.cache === false ? '--no-cache' : '';
        const dockerfilePath = config.deployment.build_docker_image.dockerfile_path;
        const dockerfileFlag = `-f ${dockerfilePath}`;
        const dockerCmd = needsSudo() ? 'sudo docker' : 'docker';
        // Use the directory containing the Dockerfile as build context
        const buildContext = path.dirname(path.resolve(dockerfilePath));
        execSync(`${dockerCmd} build ${cacheFlag} ${dockerfileFlag} --platform=linux/amd64 -t ${dockerTag}:latest ${buildContext}`, { stdio: 'pipe' });
    } catch (e) {
        console.log(chalk.red(`Error building the Docker image: ${e.message}`));
        process.exit(1);
    }
}

// Push the Docker image to docker hub
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
            console.log(chalk.red('Error: Could not extract codehash from the Docker push output'));
            process.exit(1);
        }
        const newAppCodehash = match[0].split('sha256:')[1];
        return newAppCodehash;
    } catch (e) {
        console.log(chalk.red(`Error pushing the Docker image: ${e.message}`));
        process.exit(1);
    }
}

// Build the Docker image and push it to docker hub
export async function dockerImage() {
    const config = await getConfig();
    const dockerTag = config.deployment.build_docker_image.tag;
    // Builds the image
    await buildImage(dockerTag);

    // Pushes the image and gets the new codehash
    const newAppCodehash = await pushImage(dockerTag);

    // Replaces the codehash in the yaml file
    await replaceInYaml(dockerTag, newAppCodehash);

    return newAppCodehash;
}

