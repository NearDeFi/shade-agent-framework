import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { config } from './config.js';

export function buildImage(dockerTag, cacheFlag) {
    // Builds the image
    console.log('Building Docker image...');
    try {
        if (config.deployment.os === 'mac') {
            execSync(`docker build ${cacheFlag} --platform=linux/amd64 -t ${dockerTag}:latest .`);
        } else if (config.deployment.os === 'linux') {
            execSync(`sudo docker build ${cacheFlag} --platform=linux/amd64 -t ${dockerTag}:latest .`);
        } else {
            throw new Error(`Unsupported or missing os in deployment config: ${config.deployment.os}`);
        }
        console.log('Docker image built');
        return true;
    } catch (e) {
        console.log('Error building Docker image', e);
        return false;
    }
}

export function pushImage(dockerTag) {
    // Pushes the image to docker hub
    console.log('Pushing Docker image...');
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
        const newAppCodehash = output
            .toString()
            .match(/sha256:[a-f0-9]{64}/gim)[0]
            .split('sha256:')[1];
        console.log('Docker image pushed');
        return newAppCodehash;
    } catch (e) {
        console.log('Error pushing Docker image', e);
        return null;
    }
}

export function replaceInYaml(dockerTag, codehash) {
    // Replaces the codehash in the docker-compose.yaml file
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
        console.log('Codehash replaced in docker-compose.yaml');
        return true;
    } catch (e) {
        console.log('Error replacing codehash in docker-compose.yaml', e); 
        return false;
    }
}

export function dockerImage(dockerTag, cacheFlag) {
    // Builds the image
    if (!buildImage(dockerTag, cacheFlag)) {
        return null;
    }

    // Pushes the image and gets the new codehash
    const newAppCodehash = pushImage(dockerTag);
    if (!newAppCodehash) {
        return null;
    }

    // Replaces the codehash in the docker-compose.yaml file
    if (!replaceInYaml(dockerTag, newAppCodehash)) {
        return null;
    }

    return newAppCodehash;
}