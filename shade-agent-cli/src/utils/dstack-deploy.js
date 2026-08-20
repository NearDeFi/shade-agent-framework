import crypto from "crypto";
import fs from "fs";
import chalk from "chalk";
import { parse as parseYaml } from "yaml";
import { encryptEnvVars } from "@phala/dstack-sdk/encrypt-env-vars";
import {
  vmmRpc,
  GATEWAY_RPC_PORT,
  VMM_URL,
  AUTH_CONFIG_PATH,
} from "./dstack-transport.js";
import { getAppEnvEncryptPubKey } from "./dstack-kms.js";
import { allowlistApp } from "./dstack-auth-config.js";
import { prepareAppCompose, INSTANCE_TYPE_SHAPES } from "./measurements.js";
import { loadEnvVarsForDeploy } from "./env-file.js";

function fail(message, detail) {
  console.log(chalk.red(`Error: ${message}`));
  if (detail) console.log(chalk.gray(detail));
  process.exit(1);
}

export function getInstanceShape(instanceType) {
  const shape = INSTANCE_TYPE_SHAPES[instanceType];
  if (!shape) {
    fail(
      `no vcpu/memory shape known for instance_type "${instanceType}" (known: ${Object.keys(INSTANCE_TYPE_SHAPES).join(", ")})`,
    );
  }
  return shape;
}

// The port the gateway routes `<app_id>-<port>.<domain>` to is the port the
// container publishes on the CVM, i.e. the host side of the compose mapping.
export function getAppPort(dockerComposePath) {
  const compose = parseYaml(fs.readFileSync(dockerComposePath, "utf8")) || {};
  const service = compose.services?.["shade-agent-app"];
  if (!service) {
    fail(`could not find services.shade-agent-app in ${dockerComposePath}`);
  }
  const first = Array.isArray(service.ports) ? service.ports[0] : undefined;
  if (first === undefined) {
    fail(
      `services.shade-agent-app in ${dockerComposePath} publishes no ports, so the gateway has nothing to route to`,
    );
  }
  const parts = String(first).split("/")[0].split(":");
  const port = parts.length > 1 ? parts[parts.length - 2] : parts[0];
  if (!/^\d+$/.test(port)) {
    fail(
      `could not read a port out of services.shade-agent-app.ports[0] ("${first}") in ${dockerComposePath}`,
    );
  }
  return port;
}

// Confirm the image exists and the requested shape fits before anything is
// created or allowlisted.
function preflight(sshHost, imageName, shape) {
  const images = vmmRpc(sshHost, "ListImages", {});
  const names = (images?.images || []).map((i) => i.name);
  if (!names.includes(imageName)) {
    fail(
      `the VMM has no image named "${imageName}"`,
      `available: ${names.length ? names.join(", ") : "(none)"}`,
    );
  }

  const meta = vmmRpc(sshHost, "GetMeta", {});
  const maxVcpu = meta?.resources?.max_allocable_vcpu ?? 0;
  const maxMemoryMb = meta?.resources?.max_allocable_memory_in_mb ?? 0;
  if (maxVcpu > 0 && shape.vcpu > maxVcpu) {
    fail(
      `the CVM needs ${shape.vcpu} vcpu but the VMM allows at most ${maxVcpu}`,
    );
  }
  if (maxMemoryMb > 0 && shape.memoryMb > maxMemoryMb) {
    fail(
      `the CVM needs ${shape.memoryMb} MB of memory but the VMM allows at most ${maxMemoryMb} MB`,
    );
  }
  return meta;
}

// The gateway RPC URL the CVM registers with. vmm.toml's value is preferred so
// the VMM console can still build a working dashboard link; sending it per
// deploy costs that link.
function resolveGateway(meta, gatewayDomain) {
  const baseDomain = meta?.gateway?.base_domain;
  if (baseDomain && baseDomain !== gatewayDomain) {
    fail(
      `deploy_to_dstack.gateway_domain is "${gatewayDomain}" but the gateway on the server serves "${baseDomain}", so the app URL would not resolve`,
    );
  }
  const configured = (meta?.gateway?.urls || []).filter(Boolean);
  if (configured.length > 0) {
    return { url: configured[0], fromVmm: true };
  }
  return {
    url: `https://gateway.${gatewayDomain}:${GATEWAY_RPC_PORT}`,
    fromVmm: false,
  };
}

/**
 * Deploy the agent to a self-hosted dstack server over SSH. Create-only, the
 * same as the Phala backend — existing CVMs are managed at the VMM console.
 *
 * @param {object} deployment - Parsed deployment.yaml
 * @returns {Promise<{ vmId: string, appId: string, appUrl: string, composeHash: string }>}
 */
export async function deployToDstack(deployment) {
  const cfg = deployment.deploy_to_dstack;
  const target = deployment.tee_target;
  const sshHost = cfg.ssh_host;
  const imageName = `dstack-${target.dstack_version}`;
  const shape = getInstanceShape(target.instance_type);

  const meta = preflight(sshHost, imageName, shape);
  const gateway = resolveGateway(meta, cfg.gateway_domain);
  const kmsUrls = (meta?.kms?.urls || []).filter(Boolean);
  if (kmsUrls.length === 0) {
    fail(
      `the VMM at ${VMM_URL} has no kms_urls configured, so the CVM could not get its keys or decrypt its environment`,
    );
  }

  const { allowedEnvs, composeJson, composeHash } = prepareAppCompose(deployment);
  // Read the env file and resolve the served port before touching the server,
  // so neither a missing env file nor an unroutable compose can leave a stale
  // allowlist entry or an orphaned CVM behind.
  const envVars = loadEnvVarsForDeploy(cfg.env_file_path, allowedEnvs, {
    requireFile: true,
  });
  const appPort = getAppPort(deployment.docker_compose_path);

  const appId = crypto.randomBytes(20).toString("hex");
  console.log(
    `Deploying to the self-hosted dstack server ${sshHost} as app ${appId}`,
  );

  const marker = `${cfg.app_name} ${new Date().toISOString()}`;
  const { written } = allowlistApp(sshHost, appId, composeHash, marker);
  console.log(
    written
      ? `Allowlisted the app in ${AUTH_CONFIG_PATH}`
      : `App already allowlisted in ${AUTH_CONFIG_PATH}`,
  );

  const envPubKey = getAppEnvEncryptPubKey(sshHost, appId);
  const encryptedEnv =
    envVars.length > 0 ? await encryptEnvVars(envVars, envPubKey) : "";
  console.log(
    `Encrypted ${envVars.length} environment variable(s) to the KMS key for this app`,
  );

  const params = {
    name: cfg.app_name,
    image: imageName,
    // The VMM hashes the bytes it is given and never re-serialises, so this
    // must be the same string the compose hash was taken over.
    compose_file: composeJson,
    app_id: appId,
    vcpu: shape.vcpu,
    memory: shape.memoryMb,
    disk_size: cfg.disk_size_gb,
    encrypted_env: encryptedEnv,
    kms_urls: kmsUrls,
    ports: [],
  };
  if (!gateway.fromVmm) {
    params.gateway_urls = [gateway.url];
  }

  const created = vmmRpc(sshHost, "CreateVm", params);
  const vmId = created?.id;
  if (!vmId) {
    fail(`CreateVm on ${VMM_URL} returned no VM id`, JSON.stringify(created));
  }
  console.log(`Created CVM ${vmId}`);

  const info = vmmRpc(sshHost, "GetInfo", { id: vmId });
  if (!info?.found || !info.info) {
    fail(`the VMM does not report a CVM with id ${vmId} after creating it`);
  }
  const vm = info.info;
  if (vm.app_id !== appId) {
    fail(
      `the CVM was created with app id ${vm.app_id}, but ${appId} is the one allowlisted and approved`,
    );
  }
  const provisionedVcpu = vm.configuration?.vcpu;
  const provisionedMemory = vm.configuration?.memory;
  if (provisionedVcpu !== shape.vcpu || provisionedMemory !== shape.memoryMb) {
    fail(
      `the CVM was provisioned with ${provisionedVcpu} vcpu / ${provisionedMemory} MB, but the approved measurements for ${target.instance_type} are for ${shape.vcpu} vcpu / ${shape.memoryMb} MB`,
    );
  }
  if (vm.boot_error) {
    fail(`the CVM failed to boot: ${vm.boot_error}`);
  }
  if (vm.boot_progress) {
    console.log(chalk.gray(`Boot progress: ${vm.boot_progress}`));
  }

  const appUrl = `https://${appId}-${appPort}.${cfg.gateway_domain}`;
  return { vmId, appId, appUrl, composeHash, gatewayUrl: gateway.url };
}
