import fs from "fs";
import path from "path";
import chalk from "chalk";
import { parseEnvVars } from "@phala/cloud";

// Limits the dstack guest enforces on the decrypted env before boot
// (dstack-util/src/parse_env_file.rs). Checked here so a bad env file fails
// locally instead of at boot.
const MAX_ITEMS = 1024;
const MAX_TOTAL_SIZE = 1024 * 1024;
const MAX_KEY_LENGTH = 255;
const MAX_VALUE_LENGTH = 128 * 1024;
const KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function fail(message) {
  console.log(chalk.red(`Error: ${message}`));
  process.exit(1);
}

export function validateGuestEnvLimits(envVars, envFilePath) {
  if (envVars.length > MAX_ITEMS) {
    fail(
      `${envFilePath} has ${envVars.length} environment variables, but the dstack guest rejects more than ${MAX_ITEMS}`,
    );
  }
  let totalSize = 0;
  for (const { key, value } of envVars) {
    if (!KEY_PATTERN.test(key)) {
      fail(
        `environment variable name "${key}" in ${envFilePath} is rejected by the dstack guest (must match ${KEY_PATTERN.source})`,
      );
    }
    // The guest measures UTF-8 bytes (Rust String::len), so a multi-byte value
    // can fit in JS string length and still be rejected at boot.
    const keyBytes = Buffer.byteLength(key, "utf8");
    const valueBytes = Buffer.byteLength(value, "utf8");
    if (keyBytes > MAX_KEY_LENGTH) {
      fail(
        `environment variable name "${key}" in ${envFilePath} is ${keyBytes} bytes, but the dstack guest rejects more than ${MAX_KEY_LENGTH}`,
      );
    }
    if (valueBytes > MAX_VALUE_LENGTH) {
      fail(
        `the value of "${key}" in ${envFilePath} is ${valueBytes} bytes, but the dstack guest rejects more than ${MAX_VALUE_LENGTH}`,
      );
    }
    totalSize += keyBytes + valueBytes;
  }
  if (totalSize > MAX_TOTAL_SIZE) {
    fail(
      `the environment variables in ${envFilePath} total ${totalSize} bytes, but the dstack guest rejects more than ${MAX_TOTAL_SIZE}`,
    );
  }
}

/**
 * Read an env file and keep only the keys the app compose allows, in the order
 * the file lists them.
 *
 * @param {string | undefined} envFilePath
 * @param {string[] | null} allowedEnvKeys
 * @param {{ requireFile?: boolean }} [options] - hard fail when the file is missing
 * @returns {Array<{ key: string, value: string }>}
 */
export function loadEnvVarsForDeploy(envFilePath, allowedEnvKeys, { requireFile = false } = {}) {
  if (!envFilePath) {
    if (requireFile) fail("env_file_path is required to deploy");
    return [];
  }
  const resolved = path.isAbsolute(envFilePath)
    ? envFilePath
    : path.resolve(process.cwd(), envFilePath);

  if (!fs.existsSync(resolved)) {
    if (requireFile) fail(`env file not found: ${resolved}`);
    return [];
  }

  let envVars = parseEnvVars(fs.readFileSync(resolved, "utf8"));
  if (Array.isArray(allowedEnvKeys) && allowedEnvKeys.length > 0) {
    envVars = envVars.filter((e) => allowedEnvKeys.includes(e.key));
  }
  validateGuestEnvLimits(envVars, resolved);
  return envVars;
}
