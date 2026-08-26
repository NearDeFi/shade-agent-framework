import { readFileSync, existsSync } from "fs";
import path from "path";
import chalk from "chalk";
import { parse as parseYaml } from "yaml";
import { KeyPairSigner } from "@near-js/signers";
import { JsonRpcProvider } from "@near-js/providers";
import { Account } from "@near-js/accounts";
import { platform } from "os";
import { getNearCredentials, getPhalaKey, getRpcConfig } from "./keystore.js";
import { hardwareAndOSMeasurements } from "./measurements.js";
import { hasPlaceholder } from "./placeholders.js";
import { isValidSshHost } from "./dstack-transport.js";

// A dotted DNS name the gateway serves `<app_id>-<port>.<domain>` under.
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function detectOS() {
  const platformName = platform();
  if (platformName === "darwin") return "mac";
  if (platformName === "linux") return "linux";
  console.log(
    chalk.red(
      `Error: unsupported OS: ${platformName}. Only mac and linux are supported currently.`,
    ),
  );
  process.exit(1);
}

// Parse the deployment configuration from the deployment.yaml file
export function parseDeploymentConfig(deploymentPath) {
  if (!existsSync(deploymentPath)) {
    console.log(
      chalk.red(
        `Error: deployment.yaml not found at ${deploymentPath}, you need to configure your deployment.yaml file`,
      ),
    );
    process.exit(1);
  }

  const raw = readFileSync(deploymentPath, "utf8");
  const doc = parseYaml(raw) || {};

  const {
    os,
    environment,
    network,
    docker_compose_path,
    agent_contract,
    build_docker_image,
    approve_measurements,
    approve_ppids,
    tee_config,
    whitelist_agent_for_local,
  } = doc;

  // Validation helpers
  const requireField = (cond, message) => {
    if (!cond) {
      console.log(chalk.red(`Error: deployment.yaml invalid: ${message}`));
      process.exit(1);
    }
  };
  const mustBeOneOf = (value, allowed, label) =>
    requireField(
      allowed.includes(value),
      `${label} must be one of: ${allowed.join(", ")}`,
    );
  const mustBeMultilineString = (value, label) =>
    requireField(
      typeof value === "string" && value.includes("\n"),
      `${label} must be a multiline string block`,
    );
  const mustBeBooleanOrOmitted = (value, label) =>
    requireField(
      value === undefined || typeof value === "boolean",
      `${label} must be a boolean (true or false) if specified`,
    );

  // Auto-detect OS if not provided
  const detectedOS = os || detectOS();
  if (os !== undefined) {
    mustBeOneOf(os, ["mac", "linux"], "os");
  }

  // Environment is required
  requireField(environment !== undefined, "environment is required");
  mustBeOneOf(environment, ["local", "TEE"], "environment");

  // Network is required and must be one of testnet or mainnet
  requireField(network !== undefined, "network is required");
  mustBeOneOf(network, ["testnet", "mainnet"], "network");

  // agent_contract is required and must have a contract_id
  requireField(agent_contract !== undefined, "agent_contract is required");
  requireField(
    agent_contract?.contract_id,
    "agent_contract.contract_id is required",
  );

  // docker_compose_path is required if TEE environment is enabled
  if (environment === "TEE") {
    requireField(!!docker_compose_path, "docker_compose_path is required");
  }

  // deploy_custom validations if enabled
  if (agent_contract?.deploy_custom) {
    mustBeBooleanOrOmitted(
      agent_contract.deploy_custom.enabled,
      "deploy_custom.enabled",
    );
  }
  if (
    agent_contract?.deploy_custom &&
    agent_contract.deploy_custom.enabled !== false
  ) {
    mustBeBooleanOrOmitted(
      agent_contract.deploy_custom.delete_key,
      "deploy_custom.delete_key",
    );
    requireField(
      typeof agent_contract.deploy_custom.funding_amount === "number" &&
        agent_contract.deploy_custom.funding_amount > 0 &&
        agent_contract.deploy_custom.funding_amount <= 100,
      "deploy_custom.funding_amount must be a number > 0 and <= 100",
    );

    const deployFromSource = agent_contract.deploy_custom.deploy_from_source;
    const deployFromWasm = agent_contract.deploy_custom.deploy_from_wasm;
    const useGlobalByHash = agent_contract.deploy_custom.use_global_by_hash;
    if (deployFromSource) {
      mustBeBooleanOrOmitted(
        deployFromSource.enabled,
        "deploy_custom.deploy_from_source.enabled",
      );
    }
    if (deployFromWasm) {
      mustBeBooleanOrOmitted(
        deployFromWasm.enabled,
        "deploy_custom.deploy_from_wasm.enabled",
      );
    }
    if (useGlobalByHash) {
      mustBeBooleanOrOmitted(
        useGlobalByHash.enabled,
        "deploy_custom.use_global_by_hash.enabled",
      );
    }
    const deployFromSourceEnabled =
      deployFromSource && deployFromSource.enabled !== false;
    const deployFromWasmEnabled =
      deployFromWasm && deployFromWasm.enabled !== false;
    const useGlobalByHashEnabled =
      useGlobalByHash && useGlobalByHash.enabled !== false;

    // deploy_custom.deploy_from_source.source_path is required if deploy_from_source is enabled
    if (deployFromSourceEnabled) {
      requireField(
        !!deployFromSource.source_path,
        "deploy_custom.deploy_from_source.source_path is required",
      );
      mustBeBooleanOrOmitted(
        deployFromSource.reproducible_build,
        "deploy_custom.deploy_from_source.reproducible_build",
      );
    }

    // deploy_custom.deploy_from_wasm.wasm_path is required if deploy_from_wasm is enabled
    if (deployFromWasmEnabled) {
      requireField(
        !!deployFromWasm.wasm_path,
        "deploy_custom.deploy_from_wasm.wasm_path is required",
      );
    }

    // deploy_custom.use_global_by_hash.global_hash is required if use_global_by_hash is enabled
    if (useGlobalByHashEnabled) {
      requireField(
        !!useGlobalByHash.global_hash,
        "deploy_custom.use_global_by_hash.global_hash is required",
      );
    }

    // deploy_custom must specify exactly one of deploy_from_source, deploy_from_wasm, or use_global_by_hash
    const enabledCount = [
      deployFromSourceEnabled,
      deployFromWasmEnabled,
      useGlobalByHashEnabled,
    ].filter(Boolean).length;
    requireField(
      enabledCount === 1,
      "deploy_custom must specify exactly one of deploy_from_source, deploy_from_wasm, or use_global_by_hash",
    );

    // deploy_custom.init validations if enabled
    const init = agent_contract.deploy_custom.init;
    if (init) {
      mustBeBooleanOrOmitted(init.enabled, "deploy_custom.init.enabled");
    }
    const initEnabled = init && init.enabled !== false;
    if (initEnabled) {
      // deploy_custom.init.method_name is required if init is enabled
      requireField(
        !!init.method_name,
        "deploy_custom.init.method_name is required",
      );
      // deploy_custom.init.args is required if init is enabled
      requireField(
        init.args !== undefined,
        "deploy_custom.init.args is required",
      );
      // deploy_custom.init.args must be a multiline string block
      mustBeMultilineString(init.args, "deploy_custom.init.args");
    }
  }

  // build_docker_image validations - only required when environment is TEE
  if (build_docker_image) {
    mustBeBooleanOrOmitted(
      build_docker_image.enabled,
      "build_docker_image.enabled",
    );
  }
  if (
    build_docker_image &&
    build_docker_image.enabled !== false &&
    environment === "TEE"
  ) {
    requireField(
      !!build_docker_image.tag,
      "build_docker_image.tag is required when environment is TEE",
    );
    mustBeBooleanOrOmitted(
      build_docker_image.cache,
      "build_docker_image.cache",
    );
    requireField(
      !!build_docker_image.dockerfile_path,
      "build_docker_image.dockerfile_path is required when environment is TEE",
    );
    mustBeBooleanOrOmitted(
      build_docker_image.reproducible_build,
      "build_docker_image.reproducible_build",
    );
  }

  // approve_measurements validations
  if (approve_measurements) {
    mustBeBooleanOrOmitted(
      approve_measurements.enabled,
      "approve_measurements.enabled",
    );
  }
  if (approve_measurements && approve_measurements.enabled !== false) {
    requireField(
      !!approve_measurements.method_name,
      "approve_measurements.method_name is required",
    );
    requireField(
      approve_measurements.args !== undefined,
      "approve_measurements.args is required",
    );
    mustBeMultilineString(
      approve_measurements.args,
      "approve_measurements.args",
    );
  }

  // approve_ppids validations
  if (approve_ppids) {
    mustBeBooleanOrOmitted(approve_ppids.enabled, "approve_ppids.enabled");
  }
  if (approve_ppids && approve_ppids.enabled !== false) {
    requireField(
      !!approve_ppids.method_name,
      "approve_ppids.method_name is required",
    );
    requireField(
      approve_ppids.args !== undefined,
      "approve_ppids.args is required",
    );
    mustBeMultilineString(approve_ppids.args, "approve_ppids.args");
  }

  // tee_config: everything about the TEE being targeted. The top-level fields
  // feed the measurements and are read whether or not anything is deployed;
  // `deploy` holds the deploy-only config; `phala` / `server` select the target
  // and carry its specifics.
  if (tee_config) {
    requireField(
      typeof tee_config === "object" && !Array.isArray(tee_config),
      "tee_config must be a block",
    );
    mustBeBooleanOrOmitted(
      tee_config.deploy?.enabled,
      "tee_config.deploy.enabled",
    );
    mustBeBooleanOrOmitted(
      tee_config.phala?.enabled,
      "tee_config.phala.enabled",
    );
    mustBeBooleanOrOmitted(
      tee_config.server?.enabled,
      "tee_config.server.enabled",
    );
  }

  const phalaSelected = !!tee_config?.phala && tee_config.phala.enabled !== false;
  const serverSelected =
    !!tee_config?.server && tee_config.server.enabled !== false;
  const deployEnabled = !!tee_config?.deploy && tee_config.deploy.enabled !== false;

  const usesMeasurementsPlaceholder =
    environment === "TEE" &&
    approve_measurements &&
    approve_measurements.enabled !== false &&
    hasPlaceholder(approve_measurements.args, "<MEASUREMENTS>");
  const usesPpidsPlaceholder =
    environment === "TEE" &&
    approve_ppids &&
    approve_ppids.enabled !== false &&
    hasPlaceholder(approve_ppids.args, "<PPIDS>");
  // The measurement inputs are read whenever measurements are computed — a
  // deploy or a <MEASUREMENTS> placeholder. <PPIDS> resolves from the target
  // alone, so it needs none of them.
  const needsMeasurementInputs =
    environment === "TEE" && (deployEnabled || usesMeasurementsPlaceholder);

  // Two targets are never both right, whatever else is going on.
  if (tee_config) {
    requireField(
      !(phalaSelected && serverSelected),
      "tee_config.phala and tee_config.server cannot both be enabled — pick exactly one target",
    );
  }

  // A target is only needed when something depends on which TEE this is: the
  // <MEASUREMENTS> / <PPIDS> placeholders resolve differently per target, and a
  // deploy has to know where to go. Literal values in the args need no target.
  if (usesMeasurementsPlaceholder || usesPpidsPlaceholder) {
    requireField(
      !!tee_config,
      "tee_config is required to resolve <MEASUREMENTS> / <PPIDS> (needs a phala or server target)",
    );
    requireField(
      phalaSelected || serverSelected,
      "tee_config needs one enabled target to resolve <MEASUREMENTS> / <PPIDS>, because both differ per target — enable tee_config.phala or tee_config.server, or put literal values in the args instead",
    );
  }
  if (deployEnabled) {
    requireField(
      phalaSelected || serverSelected,
      "tee_config.deploy is enabled but no target is — enable tee_config.phala or tee_config.server to say where to deploy",
    );
  }

  const teeBackend = serverSelected ? "server" : phalaSelected ? "phala" : null;

  // public_logs / public_sysinfo feed the compose hash; dstack_version /
  // instance_type feed the OS and hardware measurements.
  if (needsMeasurementInputs) {
    requireField(
      typeof tee_config?.public_logs === "boolean",
      "tee_config.public_logs is required and must be a boolean (true or false)",
    );
    requireField(
      typeof tee_config?.public_sysinfo === "boolean",
      "tee_config.public_sysinfo is required and must be a boolean (true or false)",
    );

    const supportedVersions = Object.keys(hardwareAndOSMeasurements);
    requireField(
      typeof tee_config?.dstack_version === "string" &&
        tee_config.dstack_version.length > 0,
      `tee_config.dstack_version is required (one of: ${supportedVersions.join(", ")})`,
    );
    requireField(
      supportedVersions.includes(tee_config?.dstack_version),
      `tee_config.dstack_version "${tee_config?.dstack_version}" is not supported (one of: ${supportedVersions.join(", ")})`,
    );

    const supportedInstanceTypes = Object.keys(
      hardwareAndOSMeasurements[tee_config?.dstack_version] || {},
    );
    requireField(
      typeof tee_config?.instance_type === "string" &&
        tee_config.instance_type.length > 0,
      `tee_config.instance_type is required (one of: ${supportedInstanceTypes.join(", ")})`,
    );
    requireField(
      supportedInstanceTypes.includes(tee_config?.instance_type),
      `tee_config.instance_type "${tee_config?.instance_type}" is not supported for dstack ${tee_config?.dstack_version} (one of: ${supportedInstanceTypes.join(", ")})`,
    );
  }

  // Deploy-only fields. Nothing here is read for a measure-only run.
  if (deployEnabled) {
    requireField(
      !!tee_config.deploy.app_name,
      "tee_config.deploy.app_name is required when tee_config.deploy is enabled",
    );
    requireField(
      !!tee_config.deploy.env_file_path,
      "tee_config.deploy.env_file_path is required when tee_config.deploy is enabled",
    );
  }

  // ssh_host is NOT deploy-only: it is how the CLI reaches the server's KMS to
  // compute the key-provider digest and read the PPID, so it is required
  // whenever the server is the target.
  if (serverSelected) {
    requireField(
      typeof tee_config.server.ssh_host === "string" &&
        tee_config.server.ssh_host.length > 0,
      "tee_config.server.ssh_host is required",
    );
    requireField(
      isValidSshHost(tee_config.server.ssh_host),
      `tee_config.server.ssh_host "${tee_config.server.ssh_host}" is not a valid ssh destination — use [user@]host with only letters, digits, dot, dash and underscore, and it must not start with "-"`,
    );
  }
  if (serverSelected && deployEnabled) {
    requireField(
      typeof tee_config.server.gateway_domain === "string" &&
        HOSTNAME_PATTERN.test(tee_config.server.gateway_domain),
      "tee_config.server.gateway_domain is required when deploying and must be a dotted hostname (e.g. shade.example.com)",
    );
    requireField(
      Number.isInteger(tee_config.server.disk_size_gb) &&
        tee_config.server.disk_size_gb > 0,
      "tee_config.server.disk_size_gb is required when deploying and must be a positive integer (GB)",
    );
  }

  return {
    os: detectedOS,
    environment,
    network,
    docker_compose_path: docker_compose_path,
    agent_contract: {
      contract_id: agent_contract?.contract_id,
      deploy_custom:
        agent_contract?.deploy_custom &&
        agent_contract.deploy_custom.enabled !== false
          ? {
              funding_amount: agent_contract.deploy_custom.funding_amount,
              delete_key: agent_contract.deploy_custom.delete_key === true,
              source_path:
                agent_contract.deploy_custom.deploy_from_source &&
                agent_contract.deploy_custom.deploy_from_source.enabled !==
                  false
                  ? agent_contract.deploy_custom.deploy_from_source.source_path
                  : undefined,
              reproducible_build:
                agent_contract.deploy_custom.deploy_from_source &&
                agent_contract.deploy_custom.deploy_from_source.enabled !==
                  false
                  ? agent_contract.deploy_custom.deploy_from_source
                      .reproducible_build === true
                  : false,
              wasm_path:
                agent_contract.deploy_custom.deploy_from_wasm &&
                agent_contract.deploy_custom.deploy_from_wasm.enabled !== false
                  ? agent_contract.deploy_custom.deploy_from_wasm.wasm_path
                  : undefined,
              global_hash:
                agent_contract.deploy_custom.use_global_by_hash &&
                agent_contract.deploy_custom.use_global_by_hash.enabled !==
                  false
                  ? agent_contract.deploy_custom.use_global_by_hash.global_hash
                  : undefined,
              init:
                agent_contract.deploy_custom.init &&
                agent_contract.deploy_custom.init.enabled !== false
                  ? {
                      method_name:
                        agent_contract.deploy_custom.init.method_name,
                      args: agent_contract.deploy_custom.init.args,
                      tgas: agent_contract.deploy_custom.init.tgas ?? 30,
                    }
                  : undefined,
            }
          : undefined,
    },
    build_docker_image:
      build_docker_image && build_docker_image.enabled !== false
        ? {
            tag: build_docker_image.tag,
            cache: build_docker_image.cache === true,
            dockerfile_path: build_docker_image.dockerfile_path,
            reproducible_build:
              build_docker_image.reproducible_build === true,
          }
        : undefined,
    approve_measurements:
      approve_measurements && approve_measurements.enabled !== false
        ? {
            method_name: approve_measurements.method_name,
            args: approve_measurements.args,
            tgas: approve_measurements.tgas ?? 30,
          }
        : undefined,
    approve_ppids:
      approve_ppids && approve_ppids.enabled !== false
        ? {
            method_name: approve_ppids.method_name,
            args: approve_ppids.args,
            tgas: approve_ppids.tgas ?? 30,
          }
        : undefined,
    // The single resolved view of the TEE target. `backend` is null when no
    // target is selected, which is legal for a local deploy or when
    // approve_measurements / approve_ppids use literal values.
    tee_config: {
      backend: teeBackend,
      dstack_version: tee_config?.dstack_version,
      instance_type: tee_config?.instance_type,
      public_logs: tee_config?.public_logs,
      public_sysinfo: tee_config?.public_sysinfo,
      deploy: {
        enabled: deployEnabled,
        app_name: tee_config?.deploy?.app_name,
        env_file_path: tee_config?.deploy?.env_file_path,
      },
      server: serverSelected
        ? {
            ssh_host: tee_config.server.ssh_host,
            gateway_domain: tee_config.server.gateway_domain,
            disk_size_gb: tee_config.server.disk_size_gb,
          }
        : undefined,
    },
    whitelist_agent_for_local: whitelist_agent_for_local
      ? {
          method_name: whitelist_agent_for_local.method_name,
          args: whitelist_agent_for_local.args,
          tgas: whitelist_agent_for_local.tgas ?? 30,
        }
      : undefined,
  };
}

const FASTNEAR_TESTNET = "https://test.rpc.fastnear.com";
const FASTNEAR_MAINNET = "https://free.rpc.fastnear.com";

// Build the RPC provider for a network. Honors a per-network override stored
// via `shade auth set rpc` (URL + optional Bearer API key); falls back to
// FastNEAR's public endpoints when nothing is set.
async function createDefaultProvider(network) {
  const override = await getRpcConfig(network);
  const url =
    override?.url ??
    (network === "testnet" ? FASTNEAR_TESTNET : FASTNEAR_MAINNET);
  const connectionInfo = override?.apiKey
    ? { url, headers: { Authorization: `Bearer ${override.apiKey}` } }
    : { url };
  return new JsonRpcProvider(connectionInfo, {
    retries: 3,
    backoff: 2,
    wait: 1000,
  });
}

// Memoized config - only loads when getConfig() is called
let cachedConfig = null;
let cachedDeploymentConfig = null;

// Fetch deployment config from deployment.yaml and parse it
export function getDeploymentConfig(deploymentPath) {
  // Caching deployment config to avoid parsing the file multiple times
  if (cachedDeploymentConfig) {
    return cachedDeploymentConfig;
  }

  const cwdDeployment =
    deploymentPath || path.resolve(process.cwd(), "deployment.yaml");
  const deploymentConfig = parseDeploymentConfig(cwdDeployment);
  cachedDeploymentConfig = deploymentConfig;
  return deploymentConfig;
}

// Get near credentials it won't throw an error if it doesn't exist
export async function getNearCredentialsOptional(network) {
  try {
    return await getNearCredentials(network);
  } catch (error) {
    return null;
  }
}

// Get PHALA key it won't throw an error if it doesn't exist
export async function getPhalaKeyOptional() {
  try {
    return await getPhalaKey();
  } catch (error) {
    return null;
  }
}

// Fetch the config
export async function getConfig() {
  if (cachedConfig) {
    return cachedConfig;
  }

  // Use cached deployment config if available, otherwise parse it
  const deploymentConfig = cachedDeploymentConfig || getDeploymentConfig();

  // Get network from deployment config
  const networkId = deploymentConfig?.network;
  if (!networkId) {
    console.log(chalk.red("Error: network is required in deployment.yaml"));
    process.exit(1);
  }

  // Fetch NEAR credentials from keystore based on network
  const credentials = await getNearCredentials(networkId);
  if (!credentials) {
    console.log(
      chalk.red(`Error: no master account found for ${networkId} network.`),
    );
    console.log(
      chalk.red(
        `Please run 'shade auth set' to set master account for ${networkId}.`,
      ),
    );
    process.exit(1);
  }
  const { accountId, privateKey } = credentials;

  // Fetch PHALA key if needed (only when actually deploying to Phala Cloud)
  let phalaKey = null;
  if (
    deploymentConfig?.environment === "TEE" &&
    deploymentConfig?.tee_config?.backend === "phala" &&
    deploymentConfig?.tee_config?.deploy?.enabled
  ) {
    phalaKey = await getPhalaKey();
    if (!phalaKey) {
      console.log(
        chalk.red(
          "Error: Phala API key is required for Phala Cloud deployments.",
        ),
      );
      console.log(
        chalk.red("Please run 'shade auth set' to store the Phala API key."),
      );
      process.exit(1);
    }
  }

  // Select provider based on network from deployment.yaml
  const provider = await createDefaultProvider(networkId);

  const signer = KeyPairSigner.fromSecretKey(
    /** @type {import('@near-js/crypto').KeyPairString} */ (privateKey),
  );

  const masterAccount = new Account(accountId, provider, signer);
  const contractAccount = new Account(
    deploymentConfig?.agent_contract?.contract_id,
    provider,
    signer,
  );

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
