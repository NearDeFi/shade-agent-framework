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

// The host side of one compose port mapping — the port the gateway routes
// `<app_id>-<port>.<domain>` to. Short (`8080:3000`, `0.0.0.0:8080:3000`,
// `3000/tcp`, `3000`) and long (`{ published, target }`) forms; a range or a
// missing published port has no single routable value, so it yields null.
function hostPortOf(entry) {
  if (entry && typeof entry === "object") {
    const published = entry.published ?? entry.target;
    return /^\d+$/.test(String(published)) ? String(published) : null;
  }
  const parts = String(entry).split("/")[0].split(":");
  const port = parts.length > 1 ? parts[parts.length - 2] : parts[0];
  return /^\d+$/.test(port) ? port : null;
}

// Every host port published across the compose, in order and de-duplicated.
// The gateway routes by app id, so any published port of any service is
// reachable at `<app_id>-<port>.<domain>`, not just the agent's. May be empty:
// an agent with no inbound API publishes nothing and needs no gateway URL.
export function getAppPorts(dockerComposePath) {
  const compose = parseYaml(fs.readFileSync(dockerComposePath, "utf8")) || {};
  const services = compose.services || {};
  const ports = [];
  for (const service of Object.values(services)) {
    if (!Array.isArray(service?.ports)) continue;
    for (const entry of service.ports) {
      const port = hostPortOf(entry);
      if (port && !ports.includes(port)) ports.push(port);
    }
  }
  return ports;
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
      `tee_config.server.gateway_domain is "${gatewayDomain}" but the gateway on the server serves "${baseDomain}", so the app URL would not resolve`,
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
 * @returns {Promise<{ vmId: string, appId: string, appUrls: string[], composeHash: string, gatewayUrl: string }>}
 */
export async function deployToDstack(deployment) {
  const tee = deployment.tee_config;
  const cfg = { ...tee.server, ...tee.deploy };
  const target = tee;
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
  // Read the env file before touching the server, so a missing env file can't
  // leave a stale allowlist entry or an orphaned CVM behind.
  const envVars = loadEnvVarsForDeploy(cfg.env_file_path, allowedEnvs, {
    requireFile: true,
  });
  const appPorts = getAppPorts(deployment.docker_compose_path);

  const appId = crypto.randomBytes(20).toString("hex");
  console.log(
    `Deploying to the self-hosted dstack server ${sshHost} as app ${appId}`,
  );

  // Fetch and pin the env encryption key before the allowlist write too: an
  // unverifiable signature or a signer that isn't this KMS must abort while the
  // server is still untouched.
  const envPubKey = getAppEnvEncryptPubKey(sshHost, appId);

  const marker = `${cfg.app_name} ${new Date().toISOString()}`;
  const { written } = allowlistApp(sshHost, appId, composeHash, marker);
  console.log(
    written
      ? `Allowlisted the app in ${AUTH_CONFIG_PATH}`
      : `App already allowlisted in ${AUTH_CONFIG_PATH}`,
  );

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

  const appUrls = appPorts.map(
    (port) => `https://${appId}-${port}.${cfg.gateway_domain}`,
  );
  return { vmId, appId, appUrls, composeHash, gatewayUrl: gateway.url };
}
