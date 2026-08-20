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
    deploy_to_phala,
    deploy_to_dstack,
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

  // deploy_to_phala / deploy_to_dstack validations. Exactly one deploy backend
  // may be enabled; whichever is the target also supplies the measurement
  // fields, even when its own deploy step is disabled.
  if (deploy_to_phala) {
    mustBeBooleanOrOmitted(deploy_to_phala.enabled, "deploy_to_phala.enabled");
  }
  if (deploy_to_dstack) {
    mustBeBooleanOrOmitted(
      deploy_to_dstack.enabled,
      "deploy_to_dstack.enabled",
    );
  }

  const phalaEnabled = !!deploy_to_phala && deploy_to_phala.enabled !== false;
  const dstackEnabled = !!deploy_to_dstack && deploy_to_dstack.enabled !== false;
  requireField(
    !(phalaEnabled && dstackEnabled),
    "deploy_to_phala and deploy_to_dstack cannot both be enabled — pick one deploy backend",
  );
  if (deploy_to_phala && deploy_to_dstack) {
    requireField(
      phalaEnabled || dstackEnabled,
      "deploy_to_phala and deploy_to_dstack are both present but neither is enabled — remove one so the measurement fields have a single source",
    );
  }

  // The backend whose block supplies dstack_version / instance_type /
  // public_logs / public_sysinfo.
  const teeBackend = dstackEnabled
    ? "dstack"
    : phalaEnabled
      ? "phala"
      : deploy_to_dstack
        ? "dstack"
        : deploy_to_phala
          ? "phala"
          : null;
  const teeBlock = teeBackend === "dstack" ? deploy_to_dstack : deploy_to_phala;
  const teeBlockLabel =
    teeBackend === "dstack" ? "deploy_to_dstack" : "deploy_to_phala";

  // Only require measurement fields when <MEASUREMENTS> is in the args.
  const needsMeasurementFields =
    environment === "TEE" &&
    approve_measurements &&
    approve_measurements.enabled !== false &&
    hasPlaceholder(approve_measurements.args, "<MEASUREMENTS>");

  // Deploy-only fields — only needed when the workflow will actually run.
  if (phalaEnabled) {
    requireField(
      !!deploy_to_phala.env_file_path,
      "deploy_to_phala.env_file_path is required",
    );
    requireField(
      !!deploy_to_phala.app_name,
      "deploy_to_phala.app_name is required",
    );
  }
  if (dstackEnabled) {
    requireField(
      !!deploy_to_dstack.env_file_path,
      "deploy_to_dstack.env_file_path is required",
    );
    requireField(
      !!deploy_to_dstack.app_name,
      "deploy_to_dstack.app_name is required",
    );
    requireField(
      typeof deploy_to_dstack.ssh_host === "string" &&
        deploy_to_dstack.ssh_host.length > 0,
      "deploy_to_dstack.ssh_host is required",
    );
    requireField(
      isValidSshHost(deploy_to_dstack.ssh_host),
      `deploy_to_dstack.ssh_host "${deploy_to_dstack.ssh_host}" is not a valid ssh destination — use [user@]host with only letters, digits, dot, dash and underscore, and it must not start with "-"`,
    );
    requireField(
      typeof deploy_to_dstack.gateway_domain === "string" &&
        HOSTNAME_PATTERN.test(deploy_to_dstack.gateway_domain),
      "deploy_to_dstack.gateway_domain is required and must be a dotted hostname (e.g. shade.example.com)",
    );
    requireField(
      Number.isInteger(deploy_to_dstack.disk_size_gb) &&
        deploy_to_dstack.disk_size_gb > 0,
      "deploy_to_dstack.disk_size_gb is required and must be a positive integer (GB)",
    );
  }

  // public_logs / public_sysinfo feed the compose hash (for the deploy manifest
  // and the TEE measurement). Required whenever a deploy is on OR
  // approve_measurements will run in TEE.
  if (phalaEnabled || dstackEnabled || needsMeasurementFields) {
    requireField(
      !!teeBlock,
      "a deploy_to_phala or deploy_to_dstack block is required (needs dstack_version, instance_type, public_logs, public_sysinfo)",
    );
    requireField(
      typeof teeBlock?.public_logs === "boolean",
      `${teeBlockLabel}.public_logs is required and must be a boolean (true or false)`,
    );
    requireField(
      typeof teeBlock?.public_sysinfo === "boolean",
      `${teeBlockLabel}.public_sysinfo is required and must be a boolean (true or false)`,
    );
  }

  // dstack_version / instance_type are TEE-specific (compose hash + measurement).
  if (
    (phalaEnabled || dstackEnabled || needsMeasurementFields) &&
    environment === "TEE"
  ) {
    const supportedVersions = Object.keys(hardwareAndOSMeasurements);
    requireField(
      typeof teeBlock?.dstack_version === "string" &&
        teeBlock.dstack_version.length > 0,
      `${teeBlockLabel}.dstack_version is required (one of: ${supportedVersions.join(", ")})`,
    );
    requireField(
      supportedVersions.includes(teeBlock?.dstack_version),
      `${teeBlockLabel}.dstack_version "${teeBlock?.dstack_version}" is not supported (one of: ${supportedVersions.join(", ")})`,
    );

    const supportedInstanceTypes = Object.keys(
      hardwareAndOSMeasurements[teeBlock?.dstack_version] || {},
    );
    requireField(
      typeof teeBlock?.instance_type === "string" &&
        teeBlock.instance_type.length > 0,
      `${teeBlockLabel}.instance_type is required (one of: ${supportedInstanceTypes.join(", ")})`,
    );
    requireField(
      supportedInstanceTypes.includes(teeBlock?.instance_type),
      `${teeBlockLabel}.instance_type "${teeBlock?.instance_type}" is not supported for dstack ${teeBlock?.dstack_version} (one of: ${supportedInstanceTypes.join(", ")})`,
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
    deploy_to_phala: deploy_to_phala
      ? {
          // `enabled` defaults to true when the block exists without an
          // explicit `enabled` field. The measurement-related fields below
          // are emitted regardless of `enabled` so `approve_measurements`
          // can read them even when the actual phala deploy is disabled.
          enabled: deploy_to_phala.enabled !== false,
          env_file_path: deploy_to_phala.env_file_path,
          app_name: deploy_to_phala.app_name,
          dstack_version: deploy_to_phala.dstack_version,
          instance_type: deploy_to_phala.instance_type,
          public_logs: deploy_to_phala.public_logs,
          public_sysinfo: deploy_to_phala.public_sysinfo,
        }
      : undefined,
    deploy_to_dstack: deploy_to_dstack
      ? {
          enabled: deploy_to_dstack.enabled !== false,
          env_file_path: deploy_to_dstack.env_file_path,
          app_name: deploy_to_dstack.app_name,
          dstack_version: deploy_to_dstack.dstack_version,
          instance_type: deploy_to_dstack.instance_type,
          public_logs: deploy_to_dstack.public_logs,
          public_sysinfo: deploy_to_dstack.public_sysinfo,
          ssh_host: deploy_to_dstack.ssh_host,
          gateway_domain: deploy_to_dstack.gateway_domain,
          disk_size_gb: deploy_to_dstack.disk_size_gb,
        }
      : undefined,
    // The single place the rest of the CLI reads the TEE target from, so
    // `approve_measurements` and `shade plan` don't have to know which deploy
    // backend a deployment.yaml uses.
    tee_target: {
      backend: teeBackend,
      dstack_version: teeBlock?.dstack_version,
      instance_type: teeBlock?.instance_type,
      public_logs: teeBlock?.public_logs,
      public_sysinfo: teeBlock?.public_sysinfo,
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

  // Fetch PHALA key if needed (only required for TEE environment with deploy_to_phala enabled)
  let phalaKey = null;
  if (
    deploymentConfig?.environment === "TEE" &&
    deploymentConfig?.deploy_to_phala?.enabled
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
