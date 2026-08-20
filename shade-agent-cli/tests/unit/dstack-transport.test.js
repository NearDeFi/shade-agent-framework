/**
 * Unit tests for src/utils/dstack-transport.js
 *
 * `execFileSync` with no shell is NOT sufficient protection here: `ssh` reads a
 * leading-dash argv element as an option, so an ssh_host of
 * `-oProxyCommand=<cmd>` runs that command locally. The defences are validation
 * plus always passing the host after `--`, and both are asserted here.
 *
 * Coverage:
 *  - hosts with a leading dash, shell metacharacters, whitespace or newlines
 *    are rejected by validation.
 *  - the host is always preceded by `--` in argv, so even a host that slipped
 *    through validation would not be read as an option.
 *  - request bodies travel on stdin, never in argv.
 *  - BatchMode / ConnectTimeout are always set so ssh fails instead of prompting.
 *  - each transport failure maps to its own message: ssh auth, service down,
 *    timeout, HTTP error, non-JSON body.
 *  - the KMS uses `-k` (RA-TLS on loopback) and the VMM does not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const execFileSync = vi.fn();
vi.mock("child_process", () => ({
  execFileSync: (...args) => execFileSync(...args),
}));

const {
  isValidSshHost,
  validateSshHost,
  vmmRpc,
  kmsRpc,
  sshReadFile,
  sshWriteFileAsShade,
  AUTH_CONFIG_PATH,
  VMM_URL,
  KMS_URL,
} = await import("../../src/utils/dstack-transport.js");

function ok(body) {
  execFileSync.mockReturnValue(`${JSON.stringify(body)}\n200`);
}

function failWith({ status, stdout = "", stderr = "" }) {
  execFileSync.mockImplementation(() => {
    const err = new Error("command failed");
    err.status = status;
    err.stdout = stdout;
    err.stderr = stderr;
    throw err;
  });
}

const lastArgs = () => execFileSync.mock.calls.at(-1)[1];
const lastOptions = () => execFileSync.mock.calls.at(-1)[2];
const lastRemoteCommand = () => lastArgs().at(-1);

describe("ssh_host validation", () => {
  const hostile = {
    "a ProxyCommand option": "-oProxyCommand=touch /tmp/pwned",
    "a bare leading dash": "-tdx",
    "a semicolon": "tdx;touch /tmp/pwned",
    "a backtick": "tdx`whoami`",
    "a command substitution": "tdx$(id)",
    "a pipe": "tdx|sh",
    "an ampersand": "tdx&",
    "a newline": "tdx\ntouch /tmp/pwned",
    "a space": "tdx touch",
    "a quote": `tdx'`,
    "a slash": "tdx/../x",
    empty: "",
  };

  for (const [label, host] of Object.entries(hostile)) {
    it(`rejects a host with ${label}`, () => {
      expect(isValidSshHost(host)).toBe(false);
    });
  }

  const allowed = ["tdx", "ubuntu@tdx", "ubuntu@203.0.113.10", "my-box_1.example.com"];
  for (const host of allowed) {
    it(`accepts "${host}"`, () => {
      expect(isValidSshHost(host)).toBe(true);
    });
  }

  it("exits 1 and names the value when validation fails", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    expect(() => validateSshHost("-oProxyCommand=touch /tmp/pwned")).toThrow("exit:1");
    expect(logSpy.mock.calls.flat().join(" ")).toContain("-oProxyCommand=touch /tmp/pwned");
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });
});

describe("ssh argv construction", () => {
  beforeEach(() => {
    execFileSync.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  // The `--` is the second line of defence: even a host that got past
  // validation cannot be read as an ssh option.
  it("always passes the host after --", () => {
    ok({ images: [] });
    vmmRpc("tdx", "ListImages", {});
    const args = lastArgs();
    const separator = args.indexOf("--");
    expect(separator).toBeGreaterThan(-1);
    expect(args[separator + 1]).toBe("tdx");
  });

  // Proof that the `--` actually neutralises the attack, run against the real
  // ssh binary. Without it ssh reads the host as an option and runs the
  // ProxyCommand; with it, ssh rejects the hostname and nothing executes. No
  // network round trip — the hostname is invalid, so ssh fails immediately.
  it("neutralises a ProxyCommand host with the real ssh binary", async () => {
    const { execFileSync: realExecFileSync } = await vi.importActual("child_process");
    const fs = await import("fs");
    const os = await import("os");
    const nodePath = await import("path");
    const marker = nodePath.join(os.tmpdir(), `shade-proxycommand-${process.pid}`);
    fs.rmSync(marker, { force: true });
    try {
      realExecFileSync(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=1",
          "--",
          `-oProxyCommand=touch ${marker}`,
          "true",
        ],
        { stdio: "pipe" },
      );
    } catch {
      // ssh always fails here; only the side effect matters.
    }
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("sets BatchMode and ConnectTimeout so ssh cannot prompt", () => {
    ok({ images: [] });
    vmmRpc("tdx", "ListImages", {});
    const args = lastArgs().join(" ");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("ConnectTimeout=10");
  });

  // A NEAR private key in an env blob must never reach a process listing.
  it("puts the request body on stdin, never in argv", () => {
    ok({ id: "vm-1" });
    const secret = "ed25519:SUPERSECRET";
    vmmRpc("tdx", "CreateVm", { encrypted_env: secret });
    expect(lastArgs().join(" ")).not.toContain(secret);
    expect(lastOptions().input).toContain(secret);
    expect(lastRemoteCommand()).toContain("--data-binary @-");
  });

  it("uses -k for the KMS but not for the VMM", () => {
    ok({ ca_cert: "x" });
    kmsRpc("tdx", "GetMeta", {});
    expect(lastRemoteCommand()).toContain("-k ");
    expect(lastRemoteCommand()).toContain(`${KMS_URL}/prpc/KMS.GetMeta?json`);

    ok({ images: [] });
    vmmRpc("tdx", "ListImages", {});
    expect(lastRemoteCommand()).not.toContain("-k ");
    expect(lastRemoteCommand()).toContain(`${VMM_URL}/prpc/ListImages?json`);
  });

  it("writes the allowlist atomically as the shade user", () => {
    execFileSync.mockReturnValue("");
    sshWriteFileAsShade("tdx", AUTH_CONFIG_PATH, "{}\n");
    const remote = lastRemoteCommand();
    expect(remote).toContain("sudo -n -u shade");
    expect(remote).toContain("umask 077");
    expect(remote).toContain(`${AUTH_CONFIG_PATH}.tmp`);
    expect(remote).toMatch(/mv .*\.tmp/);
    expect(lastOptions().input).toBe("{}\n");
  });

  it("rejects a remote path that is not a plain absolute path", () => {
    expect(() => sshReadFile("tdx", "/opt/shade/$(id)")).toThrow("exit:1");
    expect(() => sshReadFile("tdx", "relative/path")).toThrow("exit:1");
  });
});

describe("transport error reporting", () => {
  let logSpy;
  beforeEach(() => {
    execFileSync.mockReset();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const logged = () => logSpy.mock.calls.flat().join(" ");

  it("names the host when ssh itself fails", () => {
    failWith({ status: 255, stderr: "Permission denied (publickey)." });
    expect(() => vmmRpc("tdx", "ListImages", {})).toThrow("exit:1");
    expect(logged()).toContain("tdx");
    expect(logged()).toContain("Permission denied");
  });

  it("says nothing is listening when curl cannot connect", () => {
    failWith({ status: 7 });
    expect(() => vmmRpc("tdx", "ListImages", {})).toThrow("exit:1");
    expect(logged()).toContain("nothing listening");
    expect(logged()).toContain(VMM_URL);
  });

  it("names the url and the timeout when curl times out", () => {
    failWith({ status: 28 });
    expect(() => vmmRpc("tdx", "ListImages", {})).toThrow("exit:1");
    expect(logged()).toMatch(/timed out after \d+s/);
    expect(logged()).toContain(VMM_URL);
  });

  // --fail-with-body exits 22 and still prints the prpc error, which is the
  // most useful thing to show the operator.
  it("reports the status and the prpc error body on an HTTP error", () => {
    failWith({
      status: 22,
      stdout: '{"error":"Service not found: NopeVm"}\n400',
      stderr: "curl: (22) The requested URL returned error: 400",
    });
    expect(() => vmmRpc("tdx", "NopeVm", {})).toThrow("exit:1");
    expect(logged()).toContain("HTTP 400");
    expect(logged()).toContain("Service not found: NopeVm");
    expect(logged()).toContain("NopeVm");
  });

  it("shows the first bytes of a non-JSON response", () => {
    execFileSync.mockReturnValue("<html>proxy error</html>\n200");
    expect(() => vmmRpc("tdx", "ListImages", {})).toThrow("exit:1");
    expect(logged()).toContain("did not return JSON");
    expect(logged()).toContain("<html>proxy error</html>");
  });

  it("names the path when the allowlist cannot be read", () => {
    failWith({ status: 1, stderr: "cat: Permission denied" });
    expect(() => sshReadFile("tdx", AUTH_CONFIG_PATH)).toThrow("exit:1");
    expect(logged()).toContain(AUTH_CONFIG_PATH);
    expect(logged()).toContain("Permission denied");
  });

  it("rejects a method name that is not a plain prpc method", () => {
    expect(() => vmmRpc("tdx", "CreateVm?json&x=1", {})).toThrow("exit:1");
    expect(() => vmmRpc("tdx", "Create Vm", {})).toThrow("exit:1");
    expect(() => vmmRpc("tdx", "'; touch /tmp/pwned; '", {})).toThrow("exit:1");
  });
});
