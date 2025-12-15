import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import * as dotenv from 'dotenv';
import { KeyPairSigner } from '@near-js/signers';
import { JsonRpcProvider } from "@near-js/providers";
import { Account } from "@near-js/accounts";

// Load in environment variables from .env file
dotenv.config();

// Parse the deployment configuration from the deployment.yaml file
function parseDeploymentConfig(deploymentPath) {
    console.log('Parsing deployment configuration from deployment.yaml file');
    if (!existsSync(deploymentPath)) {
        console.log(`deployment.yaml not found at ${deploymentPath}, you need to configure your deployment.yaml file`);
        process.exit(1);
    }

    const raw = readFileSync(deploymentPath, 'utf8');
    const doc = parseYaml(raw) || {};

    const {
        os,
        environment,
        network,
        agent_contract,
        docker,
        approve_codehash,
        deploy_to_phala,
    } = doc;

    // Validation helpers
    const requireField = (cond, message) => {
        if (!cond) {
            throw new Error(`deployment.yaml invalid: ${message}`);
        }
    };
    const mustBeOneOf = (value, allowed, label) =>
        requireField(allowed.includes(value), `${label} must be one of: ${allowed.join(', ')}`);
    const mustBeMultilineString = (value, label) =>
        requireField(typeof value === 'string' && value.includes('\n'), `${label} must be a multiline string block`);

    // Required top-level fields
    requireField(os !== undefined, 'os is required');
    mustBeOneOf(os, ['mac', 'linux'], 'os');
    requireField(environment !== undefined, 'environment is required');
    mustBeOneOf(environment, ['local', 'TEE'], 'environment');

    requireField(network !== undefined, 'network is required');
    mustBeOneOf(network, ['testnet', 'mainnet'], 'network');

    // agent_contract required
    requireField(agent_contract !== undefined, 'agent_contract is required');
    requireField(agent_contract?.contract_id, 'agent_contract.contract_id is required');

    // deploy_custom validations
    if (agent_contract?.deploy_custom && agent_contract.deploy_custom.enabled !== false) {
        requireField(
            typeof agent_contract.deploy_custom.funding_amount === 'number' && agent_contract.deploy_custom.funding_amount > 0 && agent_contract.deploy_custom.funding_amount <= 100,
            'deploy_custom.funding_amount must be a number > 0 and <= 100'
        );

        if (agent_contract.deploy_custom.build_from_source) {
            requireField(
                !!agent_contract.deploy_custom.build_from_source.path_to_contract,
                'deploy_custom.build_from_source.path_to_contract is required'
            );
        }

        // Must provide exactly one of build_from_source or path_to_wasm
        const hasBuildFromSource = !!agent_contract.deploy_custom.build_from_source;
        const hasPathToWasm = agent_contract.deploy_custom.path_to_wasm !== undefined;
        requireField(
            hasBuildFromSource !== hasPathToWasm,
            'deploy_custom must specify exactly one of build_from_source or path_to_wasm'
        );

        if (agent_contract.deploy_custom.init) {
            requireField(!!agent_contract.deploy_custom.init.method_name, 'deploy_custom.init.method_name is required');
            requireField(agent_contract.deploy_custom.init.args !== undefined, 'deploy_custom.init.args is required');
            mustBeMultilineString(agent_contract.deploy_custom.init.args, 'deploy_custom.init.args');
        }
    }

    // docker validations - only required when environment is TEE
    if (docker && docker.enabled !== false && environment === 'TEE') {
        requireField(!!docker.tag, 'docker.tag is required when environment is TEE');
        requireField(docker.cache !== undefined, 'docker.cache is required when environment is TEE');
        requireField(typeof docker.cache === 'boolean', 'docker.cache must be boolean when environment is TEE');
        requireField(!!docker.docker_compose_path, 'docker.docker_compose_path is required when environment is TEE');
    }

    // approve_codehash validations
    if (approve_codehash && approve_codehash.enabled !== false) {
        requireField(!!approve_codehash.method_name, 'approve_codehash.method_name is required');
        requireField(approve_codehash.args !== undefined, 'approve_codehash.args is required');
        mustBeMultilineString(approve_codehash.args, 'approve_codehash.args');
    }

    // deploy_to_phala validations
    if (deploy_to_phala && deploy_to_phala.enabled !== false) {
        requireField(!!deploy_to_phala.docker_compose_path, 'deploy_to_phala.docker_compose_path is required');
        requireField(!!deploy_to_phala.env_file_path, 'deploy_to_phala.env_file_path is required');
    }

    return {
        os,
        environment,
        network,
        agent_contract: {
            contract_id: agent_contract?.contract_id,
            deploy_custom: agent_contract?.deploy_custom && agent_contract.deploy_custom.enabled !== false
                ? {
                    funding_amount: agent_contract.deploy_custom.funding_amount,
                    path_to_contract: agent_contract.deploy_custom.build_from_source?.path_to_contract,
                    path_to_wasm: agent_contract.deploy_custom.path_to_wasm,
                    init: agent_contract.deploy_custom.init
                        ? {
                            method_name: agent_contract.deploy_custom.init.method_name,
                            args: agent_contract.deploy_custom.init.args,
                            tgas: agent_contract.deploy_custom.init.tgas ?? 30,
                        }
                        : undefined,
                }
                : undefined,
        },
        docker: docker && docker.enabled !== false
            ? {
                tag: docker.tag,
                cache: docker.cache,
                docker_compose_path: docker.docker_compose_path,
            }
            : undefined,
        approve_codehash: approve_codehash && approve_codehash.enabled !== false
            ? {
                method_name: approve_codehash.method_name,
                args: approve_codehash.args,
                tgas: approve_codehash.tgas ?? 30,
            }
            : undefined,
        deploy_to_phala: deploy_to_phala && deploy_to_phala.enabled !== false
            ? {
                docker_compose_path: deploy_to_phala.docker_compose_path,
                env_file_path: deploy_to_phala.env_file_path,
            }
            : undefined,
    };
}

// Function to create the default RPC provider based on deployment network
function createDefaultProvider(network) {
    return new JsonRpcProvider(
    {
        url: network === 'testnet'
            ? "https://test.rpc.fastnear.com"
            : "https://free.rpc.fastnear.com"
    },
    {
        retries: 3,
        backoff: 2,
        wait: 1000,
    }
    );
}

// Always use deployment.yaml in current working directory
const cwdDeployment = path.resolve(process.cwd(), 'deployment.yaml');
const deploymentConfig = parseDeploymentConfig(cwdDeployment);

if (!process.env.ACCOUNT_ID) {
    console.log('Make sure you have set the ACCOUNT_ID in .env');
    process.exit(1);
}
const accountId = process.env.ACCOUNT_ID;

if (!process.env.PRIVATE_KEY) {
    console.log('Make sure you have set the PRIVATE_KEY in .env');
    process.exit(1);
}
const privateKey = /** @type {import('@near-js/crypto').KeyPairString} */ (process.env.PRIVATE_KEY);

if (deploymentConfig?.environment === 'TEE' && deploymentConfig?.docker) { // Only require PHALA API key if in TEE and docker is configured
    if (!process.env.PHALA_KEY) {
        console.log('Make sure you have set the PHALA_KEY in .env');
        process.exit(1);
    }
}
const phalaKey = process.env.PHALA_KEY;

// Select provider based on network from deployment.yaml (default to testnet)
const networkId = deploymentConfig?.network;
const provider = createDefaultProvider(networkId);

const signer = KeyPairSigner.fromSecretKey(privateKey);

const masterAccount = new Account(accountId, provider, signer);
const contractAccount = new Account(deploymentConfig?.agent_contract?.contract_id, provider, signer);

export const config = {
    accountId,
    privateKey,
    phalaKey,
    masterAccount,
    contractAccount,
    deployment: deploymentConfig,
};