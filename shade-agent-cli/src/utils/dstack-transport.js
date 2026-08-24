import { execFileSync } from "child_process";
import chalk from "chalk";

// Fixed endpoints on a server set up per the self-hosted TDX guide. Both bind
// loopback, so every call is tunnelled through `ssh <host> curl ...`.
export const VMM_URL = "http://127.0.0.1:10000";
export const KMS_URL = "https://127.0.0.1:11001";
// The gateway CVM is deployed with `--port tcp:0.0.0.0:9202:8000`, so 9202 is
// the guide's choice rather than a dstack default.
export const GATEWAY_RPC_PORT = 9202;
export const AUTH_CONFIG_PATH = "/opt/shade/kms/auth-config.json";

const CURL_TIMEOUT_SECONDS = 30;
// Bounds the whole ssh invocation, including the file-op path where there is no
// `curl -m` to cap it. Comfortably above the curl timeout plus a handshake.
const SSH_TIMEOUT_MS = 120_000;

// `ssh` reads a leading-dash argv element as an option, so a host of
// `-oProxyCommand=...` would run an arbitrary local command even though
// execFileSync uses no shell. Hosts are validated here and always passed
// after `--`.
const SSH_HOST_PATTERN = /^[A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?$/;
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)?$/;
const REMOTE_PATH_PATTERN = /^\/[A-Za-z0-9._\/-]+$/;

export function isValidSshHost(host) {
  return (
    typeof host === "string" &&
    host.length > 0 &&
    !host.startsWith("-") &&
    SSH_HOST_PATTERN.test(host)
  );
}

export function validateSshHost(host, label = "deploy_to_dstack.ssh_host") {
  if (!isValidSshHost(host)) {
    console.log(
      chalk.red(
        `Error: ${label} "${host}" is not a valid ssh destination. Expected [user@]host using only letters, digits, dot, dash and underscore, and it must not start with "-".`,
      ),
    );
    process.exit(1);
  }
}

function assertMethod(method) {
  if (typeof method !== "string" || !METHOD_PATTERN.test(method)) {
    console.log(
      chalk.red(`Error: invalid dstack rpc method name "${method}"`),
    );
    process.exit(1);
  }
}

function assertRemotePath(path) {
  if (typeof path !== "string" || !REMOTE_PATH_PATTERN.test(path)) {
    console.log(chalk.red(`Error: invalid remote path "${path}"`));
    process.exit(1);
  }
}

// Run one command on the server. The remote command is a fixed template built
// from validated constants only; every caller-supplied value travels on stdin.
function ssh(host, remoteCommand, { input = "" } = {}) {
  validateSshHost(host);
  try {
    const stdout = execFileSync(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "--",
        host,
        remoteCommand,
      ],
      // stderr is piped rather than inherited so it is rendered once, in gray,
      // by the error handlers below.
      {
        input,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: SSH_TIMEOUT_MS,
      },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    if (e.killed) {
      console.log(
        chalk.red(
          `Error: ssh to "${host}" did not finish within ${SSH_TIMEOUT_MS / 1000}s and was killed`,
        ),
      );
      process.exit(1);
    }
    return {
      status: e.status ?? 255,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? (e.message || ""),
    };
  }
}

function failSsh(host, result) {
  console.log(
    chalk.red(
      `Error: ssh to "${host}" failed (exit ${result.status}). Check the host is reachable and the key is loaded.`,
    ),
  );
  if (result.stderr) console.log(chalk.gray(result.stderr.trim()));
  process.exit(1);
}

function failCurl(host, url, method, result) {
  if (result.status === 7) {
    console.log(
      chalk.red(
        `Error: nothing listening on ${url} (${method}); is dstack-vmm / the KMS running on "${host}"?`,
      ),
    );
  } else if (result.status === 28) {
    console.log(
      chalk.red(
        `Error: ${method} on ${url} timed out after ${CURL_TIMEOUT_SECONDS}s`,
      ),
    );
  } else {
    console.log(
      chalk.red(
        `Error: ${method} on ${url} failed (curl exit ${result.status})`,
      ),
    );
  }
  if (result.stderr) console.log(chalk.gray(result.stderr.trim()));
  process.exit(1);
}

// prpc-json responses carry the HTTP status appended by `-w`, so the status is
// available even when curl itself exited 0.
function splitStatus(stdout) {
  const trimmed = stdout.replace(/\n$/, "");
  const cut = trimmed.lastIndexOf("\n");
  if (cut === -1) return { body: "", httpCode: trimmed.trim() };
  return {
    body: trimmed.slice(0, cut),
    httpCode: trimmed.slice(cut + 1).trim(),
  };
}

function rpc(host, baseUrl, method, params, { insecure = false } = {}) {
  assertMethod(method);
  const body = JSON.stringify(params ?? {});
  const remote =
    `curl -sS ${insecure ? "-k " : ""}-m ${CURL_TIMEOUT_SECONDS} --fail-with-body ` +
    `-X POST '${baseUrl}/prpc/${method}?json' ` +
    `-H 'Content-Type: application/json' --data-binary @- -w '\\n%{http_code}'`;

  const result = ssh(host, remote, { input: body });
  if (result.status === 255) failSsh(host, result);
  // 22 is curl's --fail-with-body exit for an HTTP error; the body is still on
  // stdout, so it is reported below rather than treated as a transport failure.
  if (result.status !== 0 && result.status !== 22) {
    failCurl(host, baseUrl, method, result);
  }

  const { body: responseBody, httpCode } = splitStatus(result.stdout);
  if (httpCode !== "200") {
    console.log(
      chalk.red(
        `Error: ${method} on ${baseUrl} returned HTTP ${httpCode || "(no status)"}`,
      ),
    );
    // Capped like the parse-failure path below; a prpc error body is short but
    // a misrouted response need not be.
    if (responseBody) {
      console.log(chalk.gray(responseBody.trim().slice(0, 500)));
    }
    process.exit(1);
  }

  try {
    return JSON.parse(responseBody);
  } catch (e) {
    console.log(
      chalk.red(
        `Error: ${method} on ${baseUrl} did not return JSON: ${responseBody.slice(0, 200)}`,
      ),
    );
    process.exit(1);
  }
}

export function vmmRpc(host, method, params) {
  return rpc(host, VMM_URL, method, params);
}

// The KMS serves RA-TLS on loopback, so its cert is not in any public chain and
// `-k` is expected. Trust comes from pinning the signer to GetMeta.k256_pubkey,
// not from TLS.
export function kmsRpc(host, method, params) {
  return rpc(host, KMS_URL, `KMS.${method}`, params, { insecure: true });
}

export function sshReadFile(host, path) {
  assertRemotePath(path);
  const result = ssh(host, `sudo -n -u shade cat '${path}'`);
  if (result.status === 255) failSsh(host, result);
  if (result.status !== 0) {
    console.log(
      chalk.red(`Error: could not read ${path} on "${host}" (exit ${result.status})`),
    );
    if (result.stderr) console.log(chalk.gray(result.stderr.trim()));
    process.exit(1);
  }
  return result.stdout;
}

// Write via a temp file + rename so a broken pipe can never leave a truncated
// allowlist behind.
export function sshWriteFileAsShade(host, path, content) {
  assertRemotePath(path);
  const remote =
    `sudo -n -u shade sh -c "umask 077; cat > '${path}.tmp' && mv '${path}.tmp' '${path}'"`;
  const result = ssh(host, remote, { input: content });
  if (result.status === 255) failSsh(host, result);
  if (result.status !== 0) {
    console.log(
      chalk.red(`Error: could not write ${path} on "${host}" (exit ${result.status})`),
    );
    if (result.stderr) console.log(chalk.gray(result.stderr.trim()));
    process.exit(1);
  }
}
