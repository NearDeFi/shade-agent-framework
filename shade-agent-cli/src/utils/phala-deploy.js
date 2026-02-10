import fs from "fs";
import path from "path";
import { createClient, deployAppAuth, encryptEnvVars, parseEnvVars } from "@phala/cloud";

const CLOUD_URL = "https://cloud.phala.com";

// ==================================================================
//
// Helper functions
//
// ==================================================================

function assert_not_null(condition, message) {
  if (condition === null || condition === undefined) {
    throw new Error(message);
  }
  return condition;
}

/**
 * Remove undefined fields from object recursively (for cleaner API requests)
 */
function removeUndefined(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null) {
      if (typeof value === "object" && !Array.isArray(value)) {
        result[key] = removeUndefined(value);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

// ==================================================================
//
// Main function
//
// ==================================================================

/**
 * Deploy a new CVM (create flow). Supports PHALA (centralized) and ETHEREUM/BASE (on-chain) KMS.
 *
 * @param {import('@phala/cloud').Client} client - Phala Cloud client from createClient()
 * @param {string} docker_compose_yml - Raw docker-compose YAML string
 * @param {Array<{ key: string, value: string }>} env_vars - Environment variables to inject
 * @param {object} args - Parsed CLI-style args, e.g. from arg(spec): --name, --instance-type, --disk-size, --region, --os-image, --kms, --private-key, --rpc-url, --env, --uuid
 */
async function deploy_new_cvm(client, docker_compose_yml, env_vars, args) {
  //
  // Step 1: Parse and validate parameters
  //
  const name = args["--name"] || "app";
  const instance_type = args["--instance-type"] || "tdx.small";
  const disk_size = args["--disk-size"];
  const region = args["--region"];
  const os_image = args["--os-image"];
  const kms_type = args["--kms"];
  const private_key = args["--private-key"];
  const rpc_url = args["--rpc-url"];

  const is_onchain_kms = kms_type === "ETHEREUM" || kms_type === "BASE";
  if (is_onchain_kms) {
    if (!private_key) {
      throw new Error("--private-key is required for on-chain KMS deployment");
    }
    if (!rpc_url) {
      throw new Error("--rpc-url is required for on-chain KMS deployment");
    }
  }

  //
  // Step 2: Provision CVM (automatic resource selection)
  //
  const provision_payload = /** @type {import('@phala/cloud').ProvisionCvmRequest} */ (
    removeUndefined({
      name,
      instance_type,
      compose_file: {
        docker_compose_file: docker_compose_yml,
        allowed_envs: env_vars.map((e) => e.key),
      },
      disk_size,
      region,
      image: os_image,
      kms: kms_type,
    })
  );

  const provision = await client.provisionCvm(provision_payload);

  //
  // Step 3: Deploy based on KMS type
  //
  let result;

  if (provision.app_id && provision.app_env_encrypt_pubkey) {
    //
    // Centralized KMS (PHALA) - app_id provided by provision
    //
    const encrypted_env_vars =
      env_vars.length > 0
        ? await encryptEnvVars(env_vars, provision.app_env_encrypt_pubkey)
        : undefined;

    result = await client.commitCvmProvision({
      app_id: provision.app_id,
      compose_hash: provision.compose_hash,
      encrypted_env: encrypted_env_vars,
      env_keys: env_vars.map((e) => e.key),
    });
  } else {
    //
    // On-chain KMS (ETHEREUM/BASE) - need to deploy contract to get app_id
    //

    const kms_id = assert_not_null(provision.kms_id, "KMS ID not returned from provision");
    const device_id = assert_not_null(provision.device_id, "Device ID not returned from provision");

    const kms_list = await client.getKmsList();
    const kms = kms_list.items.find((k) => k.id === kms_id || k.slug === kms_id);
    assert_not_null(kms, `KMS ${kms_id} not found`);
    assert_not_null(kms.kms_contract_address, "KMS contract address not found");
    assert_not_null(kms.chain, "KMS chain info not found");

    const deployed_contract = await deployAppAuth({
      chain: /** @type {import('viem').Chain} */ (kms.chain),
      rpcUrl: rpc_url,
      kmsContractAddress: kms.kms_contract_address,
      privateKey: private_key,
      deviceId: device_id,
      composeHash: provision.compose_hash,
    });

    const contract = /** @type {{ appId?: string, appAuthAddress: string, deployer: string }} */ (
      deployed_contract
    );
    const app_id = assert_not_null(
      contract.appId,
      "App ID not returned from contract deployment",
    );

    const kms_slug = assert_not_null(kms.slug, "KMS slug not found");
    const pubkey_resp = await client.getAppEnvEncryptPubKey({
      app_id: app_id,
      kms: kms_slug,
    });


    const encrypted_env_vars =
      env_vars.length > 0 ? await encryptEnvVars(env_vars, pubkey_resp.public_key) : undefined;

    result = await client.commitCvmProvision({
      app_id: app_id,
      compose_hash: provision.compose_hash,
      encrypted_env: encrypted_env_vars,
      env_keys: env_vars.map((e) => e.key),
      kms_id: kms_slug,
      contract_address: contract.appAuthAddress,
      deployer_address: contract.deployer,
    });
  }

  return result;
}

// ==================================================================
//
// High-level deploy for shade-agent-cli (PHALA KMS, new CVM only)
//
// ==================================================================

/**
 * Deploy to Phala Cloud (new CVM, PHALA KMS). For use by shade-agent-cli deploy.
 *
 * @param {object} options
 * @param {string} options.appName - CVM name (e.g. from deployment.yaml deploy_to_phala.app_name)
 * @param {string} options.apiKey - Phala Cloud API key
 * @param {string} options.composePath - Path to docker-compose file
 * @param {string} [options.envFilePath] - Path to .env file (optional)
 * @param {string[]} [options.allowedEnvKeys] - Env keys to pass (optional; if omitted, all keys from env file are used)
 * @returns {Promise<{ success: boolean, vm_uuid: string, name: string, app_id: string, dashboard_url: string }>}
 */
async function deployToPhala(options) {
  const { appName, apiKey, composePath, envFilePath, allowedEnvKeys = null } = options;

  if (!appName || appName.length <= 3) {
    throw new Error("App name must be longer than 3 characters");
  }
  if (!apiKey) {
    throw new Error("API key is required");
  }
  const resolvedComposePath = path.isAbsolute(composePath)
    ? composePath
    : path.resolve(process.cwd(), composePath);
  if (!fs.existsSync(resolvedComposePath)) {
    throw new Error(`Compose file not found: ${resolvedComposePath}`);
  }

  const composeContent = fs.readFileSync(resolvedComposePath, "utf8");

  let envVars = [];
  if (envFilePath) {
    const resolvedEnvPath = path.isAbsolute(envFilePath)
      ? envFilePath
      : path.resolve(process.cwd(), envFilePath);
    if (fs.existsSync(resolvedEnvPath)) {
      const envFileContent = fs.readFileSync(resolvedEnvPath, "utf8");
      envVars = parseEnvVars(envFileContent);
      if (Array.isArray(allowedEnvKeys) && allowedEnvKeys.length > 0) {
        envVars = envVars.filter((e) => allowedEnvKeys.includes(e.key));
      }
    }
  }

  const client = createClient({ apiKey });
  const args = {
    "--name": appName,
    "--instance-type": "tdx.small",
    "--os-image": "dstack-0.5.5",
  };
  const result = await deploy_new_cvm(client, composeContent, envVars, args);

  const vm_uuid = result.vm_uuid ?? String(result.id);
  return {
    success: true,
    vm_uuid,
    name: result.name,
    app_id: result.app_id ?? "",
    dashboard_url: `${CLOUD_URL}/dashboard/cvms/${vm_uuid}`,
  };
}

export { deploy_new_cvm, deployToPhala, createClient, parseEnvVars, removeUndefined, assert_not_null };
