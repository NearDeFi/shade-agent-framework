/**
 * Unit tests for src/utils/docker-utils.js
 *
 * Coverage:
 *  - getSudoPrefix: returns "sudo " on Linux, "" elsewhere.
 *  - dockerExec: invokes execFileSync with the right (file, args) tuple,
 *    switching to `sudo docker ...` on Linux.
 *  - runWithSudoOnLinux: same shape for arbitrary commands (e.g. chown).
 *  - SAF-020 regression: malicious arguments stay as ONE argv element — never
 *    parsed by a shell.
 *
 * Notes:
 *  - child_process.execFileSync and os.platform are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({
  execFileSync: vi.fn(() => Buffer.from("")),
}));
vi.mock("os", () => ({
  platform: vi.fn(),
}));

const { execFileSync } = await import("child_process");
const { platform } = await import("os");
const { getSudoPrefix, dockerExec, runWithSudoOnLinux } = await import(
  "../../src/utils/docker-utils.js"
);

describe("docker-utils", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("getSudoPrefix", () => {
    // Linux requires sudo for docker by default; the rest of the CLI relies
    // on this returning "sudo ".
    it("returns 'sudo ' on linux", () => {
      vi.mocked(platform).mockReturnValue("linux");
      expect(getSudoPrefix()).toBe("sudo ");
    });

    // macOS / Windows run docker without sudo.
    it("returns '' on darwin", () => {
      vi.mocked(platform).mockReturnValue("darwin");
      expect(getSudoPrefix()).toBe("");
    });
  });

  describe("dockerExec", () => {
    // On Linux, docker is invoked via `sudo docker <args>` — the helper
    // prepends `docker` to the argv array and switches the file to `sudo`.
    it("on linux invokes execFileSync('sudo', ['docker', ...args])", () => {
      vi.mocked(platform).mockReturnValue("linux");
      dockerExec(["push", "myimage"], { stdio: "pipe" });
      expect(execFileSync).toHaveBeenCalledWith(
        "sudo",
        ["docker", "push", "myimage"],
        { stdio: "pipe" },
      );
    });

    // On non-Linux, docker is the file directly with no sudo prefix.
    it("on darwin invokes execFileSync('docker', args)", () => {
      vi.mocked(platform).mockReturnValue("darwin");
      dockerExec(["push", "myimage"], { stdio: "pipe" });
      expect(execFileSync).toHaveBeenCalledWith(
        "docker",
        ["push", "myimage"],
        { stdio: "pipe" },
      );
    });

    // SAF-020 regression: a tag like 'foo; rm -rf /' must be a SINGLE argv
    // element — proves no shell is involved and shell metacharacters are inert.
    it("passes a malicious tag as a single argv element (no shell)", () => {
      vi.mocked(platform).mockReturnValue("darwin");
      const evil = "foo; rm -rf /";
      dockerExec(["push", evil], { stdio: "pipe" });
      const args = vi.mocked(execFileSync).mock.calls[0][1];
      expect(args).toHaveLength(2);
      expect(args[1]).toBe(evil);
    });
  });

  describe("runWithSudoOnLinux", () => {
    // On Linux, the helper switches to `sudo <cmd> <args>` for arbitrary cmds.
    it("on linux invokes execFileSync('sudo', [cmd, ...args])", () => {
      vi.mocked(platform).mockReturnValue("linux");
      runWithSudoOnLinux("chown", ["1000:1000", "/wasm"], { stdio: "pipe" });
      expect(execFileSync).toHaveBeenCalledWith(
        "sudo",
        ["chown", "1000:1000", "/wasm"],
        { stdio: "pipe" },
      );
    });

    // On non-Linux, the cmd is the file directly with no sudo prefix.
    it("on darwin invokes execFileSync(cmd, args)", () => {
      vi.mocked(platform).mockReturnValue("darwin");
      runWithSudoOnLinux("chown", ["1000:1000", "/wasm"], { stdio: "pipe" });
      expect(execFileSync).toHaveBeenCalledWith(
        "chown",
        ["1000:1000", "/wasm"],
        { stdio: "pipe" },
      );
    });
  });
});
