import chalk from "chalk";
import { sshReadFile, sshWriteFileAsShade, AUTH_CONFIG_PATH } from "./dstack-transport.js";

function normalizeHex(value) {
  const lower = String(value).toLowerCase();
  return lower.startsWith("0x") ? lower : `0x${lower}`;
}

/**
 * Add an app entry to a parsed auth-config, leaving everything else untouched.
 * Pure — returns a new object and never mutates the input.
 *
 * The apps map is rebuilt by spread rather than assignment: `__proto__` survives
 * JSON.parse as an own key, and assigning to it on a fresh object would set a
 * prototype instead of an entry.
 */
export function mergeAppEntry(config, appId, composeHash, marker) {
  const id = normalizeHex(appId);
  const hash = normalizeHex(composeHash);
  const existingApps =
    config && typeof config.apps === "object" && config.apps !== null
      ? config.apps
      : {};

  const existing = Object.prototype.hasOwnProperty.call(existingApps, id)
    ? existingApps[id]
    : null;
  const composeHashes = Array.isArray(existing?.composeHashes)
    ? existing.composeHashes.map(normalizeHex)
    : [];
  const hashes = composeHashes.includes(hash)
    ? composeHashes
    : [...composeHashes, hash];

  const entry = {
    composeHashes: hashes,
    devices: [],
    allowAnyDevice: true,
    _shade: marker,
  };

  return {
    ...config,
    apps: { ...existingApps, [id]: entry },
  };
}

// Read the allowlist, add this deploy's app entry, and write it back. auth-simple
// re-reads the file per request, so no service restart is needed.
export function allowlistApp(sshHost, appId, composeHash, marker) {
  const raw = sshReadFile(sshHost, AUTH_CONFIG_PATH);

  let config;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    console.log(
      chalk.red(
        `Error: ${AUTH_CONFIG_PATH} on "${sshHost}" is not valid JSON, so the app cannot be allowlisted: ${e.message}`,
      ),
    );
    process.exit(1);
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    console.log(
      chalk.red(
        `Error: ${AUTH_CONFIG_PATH} on "${sshHost}" is not a valid auth-config (expected a JSON object, got ${Array.isArray(config) ? "an array" : typeof config})`,
      ),
    );
    process.exit(1);
  }

  const merged = mergeAppEntry(config, appId, composeHash, marker);
  const serialized = `${JSON.stringify(merged, null, 2)}\n`;
  if (serialized === raw) return { written: false };

  sshWriteFileAsShade(sshHost, AUTH_CONFIG_PATH, serialized);
  return { written: true };
}
