import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { config } from './config.js';

export function buildImage(dockerTag) {
    // Builds the image
    console.log('Building the Docker image');
    try {
        const cacheFlag = config.deployment.docker.cache === false ? '--no-cache' : '';
        if (config.deployment.os === 'mac') {
            execSync(`docker build ${cacheFlag} --platform=linux/amd64 -t ${dockerTag}:latest .`);
        } else if (config.deployment.os === 'linux') {
            execSync(`sudo docker build ${cacheFlag} --platform=linux/amd64 -t ${dockerTag}:latest .`);
        } else {
            throw new Error(`Unsupported or missing os in deployment config: ${config.deployment.os}`);
        }
    } catch (e) {
        console.log('Error building the Docker image', e);
        process.exit(1);
    }
}

export function pushImage(dockerTag) {
    // Pushes the image to docker hub
    console.log('Pushing the Docker image');
    try {
        let output;
        if (config.deployment.os === 'mac') {
            output = execSync(
                `docker push ${dockerTag}`,
            );
        } else if (config.deployment.os === 'linux') {
            output = execSync(
                `sudo docker push ${dockerTag}`,
            );
        } else {
            throw new Error(`Unsupported or missing os in deployment config: ${config.deployment.os}`);
        }
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

export function replaceInYaml(dockerTag, codehash) {
    // Replaces the codehash in the docker-compose.yaml file
    console.log('Replacing the codehash in the docker-compose.yaml file');
    try {
        const path = config.deployment.docker.docker_compose_path;
        let data = readFileSync(path, 'utf8');
        const match = data.match(/@sha256:[a-f0-9]{64}/gim)[1];
        const replacementHash = `@sha256:${codehash}`;
        data = data.replace(match, replacementHash);
        const index = data.indexOf(replacementHash);
        const lastIndex = data.lastIndexOf('image:', index);
        data =
            data.slice(0, lastIndex) +
            `image: ` +
            dockerTag +
            data.slice(index);
        writeFileSync(path, data, 'utf8');
    } catch (e) {
        console.log('Error replacing codehash in the docker-compose.yaml file', e); 
        process.exit(1);
    }
}

export function dockerImage() {
    const dockerTag = config.deployment.docker.tag;
    // Builds the image
    buildImage(dockerTag);

    // Pushes the image and gets the new codehash
    const newAppCodehash = pushImage(dockerTag);

    // Replaces the codehash in the docker-compose.yaml file
    replaceInYaml(dockerTag, newAppCodehash);

    return newAppCodehash;
}