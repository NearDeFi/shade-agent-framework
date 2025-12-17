import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { KeyPairSigner } from '@near-js/signers';
import { JsonRpcProvider } from "@near-js/providers";
import { Account } from "@near-js/accounts";
import { platform } from 'os';
import { getCredentials, getPhalaKey } from './keystore.js';

function detectOS() {
    const platformName = platform();
    if (platformName === 'darwin') return 'mac';
    if (platformName === 'linux') return 'linux';
    console.log(`Unsupported OS: ${platformName}. Only mac and linux are supported.`);
    process.exit(1);
}

// Parse the deployment configuration from the deployment.yaml file
export function parseDeploymentConfig(deploymentPath) {
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
        docker_compose_path,
        agent_contract,
        build_docker_image,
        approve_codehash,
        deploy_to_phala,
        whitelist_agent,
    } = doc;

    // Validation helpers
    const requireField = (cond, message) => {
        if (!cond) {
            console.log(`deployment.yaml invalid: ${message}`);
            process.exit(1);
        }
    };
    const mustBeOneOf = (value, allowed, label) =>
        requireField(allowed.includes(value), `${label} must be one of: ${allowed.join(', ')}`);
    const mustBeMultilineString = (value, label) =>
        requireField(typeof value === 'string' && value.includes('\n'), `${label} must be a multiline string block`);

    // Auto-detect OS if not provided
    const detectedOS = os || detectOS();
    if (os !== undefined) {
        mustBeOneOf(os, ['mac', 'linux'], 'os');
    }

    // Environment is still required in deployment.yaml
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

        const deployFromSource = agent_contract.deploy_custom.deploy_from_source;
        const deployFromWasm = agent_contract.deploy_custom.deploy_from_wasm;
        const deployFromSourceEnabled = deployFromSource && deployFromSource.enabled !== false;
        const deployFromWasmEnabled = deployFromWasm && deployFromWasm.enabled !== false;

        if (deployFromSourceEnabled) {
            requireField(
                !!deployFromSource.source_path,
                'deploy_custom.deploy_from_source.source_path is required'
            );
        }

        if (deployFromWasmEnabled) {
            requireField(
                !!deployFromWasm.wasm_path,
                'deploy_custom.deploy_from_wasm.wasm_path is required'
            );
        }

        // Must provide exactly one of deploy_from_source or deploy_from_wasm enabled
        requireField(
            deployFromSourceEnabled !== deployFromWasmEnabled,
            'deploy_custom must specify exactly one of deploy_from_source or deploy_from_wasm with enabled: true'
        );

        const init = agent_contract.deploy_custom.init;
        const initEnabled = init && init.enabled !== false;
        if (initEnabled) {
            requireField(!!init.method_name, 'deploy_custom.init.method_name is required');
            requireField(init.args !== undefined, 'deploy_custom.init.args is required');
            mustBeMultilineString(init.args, 'deploy_custom.init.args');
        }
    }

    // docker_compose_path validation - always required
    requireField(!!docker_compose_path, 'docker_compose_path is required');

    // build_docker_image validations - only required when environment is TEE
    if (build_docker_image && build_docker_image.enabled !== false && environment === 'TEE') {
        requireField(!!build_docker_image.tag, 'build_docker_image.tag is required when environment is TEE');
        requireField(build_docker_image.cache !== undefined, 'build_docker_image.cache is required when environment is TEE');
        requireField(typeof build_docker_image.cache === 'boolean', 'build_docker_image.cache must be boolean when environment is TEE');
        requireField(!!build_docker_image.dockerfile_path, 'build_docker_image.dockerfile_path is required when environment is TEE');
    }

    // approve_codehash validations
    if (approve_codehash && approve_codehash.enabled !== false) {
        requireField(!!approve_codehash.method_name, 'approve_codehash.method_name is required');
        requireField(approve_codehash.args !== undefined, 'approve_codehash.args is required');
        mustBeMultilineString(approve_codehash.args, 'approve_codehash.args');
    }

    // deploy_to_phala validations
    if (deploy_to_phala && deploy_to_phala.enabled !== false) {
        requireField(!!deploy_to_phala.env_file_path, 'deploy_to_phala.env_file_path is required');
        requireField(!!deploy_to_phala.app_name, 'deploy_to_phala.app_name is required');
    }

    return {
        os: detectedOS,
        environment,
        network,
        docker_compose_path: docker_compose_path,
        agent_contract: {
            contract_id: agent_contract?.contract_id,
            deploy_custom: agent_contract?.deploy_custom && agent_contract.deploy_custom.enabled !== false
                ? {
                    funding_amount: agent_contract.deploy_custom.funding_amount,
                    source_path: (agent_contract.deploy_custom.deploy_from_source && agent_contract.deploy_custom.deploy_from_source.enabled !== false)
                        ? agent_contract.deploy_custom.deploy_from_source.source_path
                        : undefined,
                    wasm_path: (agent_contract.deploy_custom.deploy_from_wasm && agent_contract.deploy_custom.deploy_from_wasm.enabled !== false)
                        ? agent_contract.deploy_custom.deploy_from_wasm.wasm_path
                        : undefined,
                    init: (agent_contract.deploy_custom.init && agent_contract.deploy_custom.init.enabled !== false)
                        ? {
                            method_name: agent_contract.deploy_custom.init.method_name,
                            args: agent_contract.deploy_custom.init.args,
                            tgas: agent_contract.deploy_custom.init.tgas ?? 30,
                        }
                        : undefined,
                }
                : undefined,
        },
        build_docker_image: build_docker_image && build_docker_image.enabled !== false
            ? {
                tag: build_docker_image.tag,
                cache: build_docker_image.cache,
                dockerfile_path: build_docker_image.dockerfile_path,
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
                env_file_path: deploy_to_phala.env_file_path,
                app_name: deploy_to_phala.app_name,
            }
            : undefined,
        whitelist_agent: whitelist_agent
            ? {
                method_name: whitelist_agent.method_name,
                args: whitelist_agent.args,
                tgas: whitelist_agent.tgas ?? 30,
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

// Memoized config - only loads when getConfig() is called
let cachedConfig = null;
let cachedDeploymentConfig = null;

/**
 * Get the deployment configuration from deployment.yaml without requiring credentials.
 * This is useful for plan mode or other read-only operations.
 * @param {string} [deploymentPath] - Optional path to deployment.yaml. Defaults to ./deployment.yaml
 * @returns {Object} The deployment configuration object
 */
export function getDeploymentConfig(deploymentPath) {
    if (cachedDeploymentConfig) {
        return cachedDeploymentConfig;
    }

    const cwdDeployment = deploymentPath || path.resolve(process.cwd(), 'deployment.yaml');
    const deploymentConfig = parseDeploymentConfig(cwdDeployment);
    cachedDeploymentConfig = deploymentConfig;
    return deploymentConfig;
}

/**
 * Get credentials optionally (returns null if they don't exist or if there's an error).
 * @param {string} network - 'testnet' or 'mainnet'
 * @returns {Promise<{accountId: string, privateKey: string} | null>}
 */
export async function getCredentialsOptional(network) {
    try {
        return await getCredentials(network);
    } catch (error) {
        return null;
    }
}

/**
 * Get PHALA key optionally (returns null if it doesn't exist or if there's an error).
 * @returns {Promise<string | null>}
 */
export async function getPhalaKeyOptional() {
    try {
        return await getPhalaKey();
    } catch (error) {
        return null;
    }
}

/**
 * Get the configuration. This function loads the config lazily and caches it.
 * The config is only loaded when deploy command is used.
 * Credentials are fetched from the keystore based on the network in deployment.yaml.
 * @returns {Promise<Object>} The configuration object
 */
export async function getConfig() {
    if (cachedConfig) {
        return cachedConfig;
    }

    // Use cached deployment config if available, otherwise parse it
    const deploymentConfig = cachedDeploymentConfig || getDeploymentConfig();

    // Get network from deployment config
    const networkId = deploymentConfig?.network;
    if (!networkId) {
        console.log('Network is required in deployment.yaml');
        process.exit(1);
    }

    // Fetch credentials from keystore based on network
    const credentials = await getCredentials(networkId);
    if (!credentials) {
        console.log(`No master account found for ${networkId} network.`);
        console.log(`Please run 'shade auth set' to set master account for ${networkId}.`);
        process.exit(1);
    }
    const { accountId, privateKey } = credentials;

    // Fetch PHALA key if needed (only required for TEE environment with deploy_to_phala)
    let phalaKey = null;
    if (deploymentConfig?.environment === 'TEE' && deploymentConfig?.deploy_to_phala) {
        phalaKey = await getPhalaKey();
        if (!phalaKey) {
            console.log('PHALA API key is required for Phala Cloud deployments.');
            console.log("Please run 'shade auth set' to store the PHALA API key.");
            process.exit(1);
        }
    }

    // Select provider based on network from deployment.yaml
    const provider = createDefaultProvider(networkId);

    const signer = KeyPairSigner.fromSecretKey(/** @type {import('@near-js/crypto').KeyPairString} */ (privateKey));

    const masterAccount = new Account(accountId, provider, signer);
    const contractAccount = new Account(deploymentConfig?.agent_contract?.contract_id, provider, signer);

    cachedConfig = {
        accountId,
        privateKey,
        phalaKey,
        masterAccount,
        contractAccount,
        deployment: deploymentConfig,
    };

    return cachedConfig;
}

