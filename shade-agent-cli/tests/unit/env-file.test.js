/**
 * Unit tests for src/utils/env-file.js
 *
 * The guest re-parses the decrypted env before boot and enforces hard limits
 * (dstack-util/src/parse_env_file.rs). Breaking one of those means a CVM that
 * boots and then dies, so they are checked locally instead.
 *
 * Coverage:
 *  - only keys the compose allows are sent, in file order.
 *  - a missing file is tolerated by default and fatal with requireFile.
 *  - the guest's limits: >1024 vars, >1 MB total, >128 KB value, >255-char key,
 *    and keys failing ^[a-zA-Z_][a-zA-Z0-9_]*$ all fail locally.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const { loadEnvVarsForDeploy, validateGuestEnvLimits } = await import(
  "../../src/utils/env-file.js"
);

let tmpDir;
let envPath;

function write(content) {
  fs.writeFileSync(envPath, content);
  return envPath;
}

describe("loadEnvVarsForDeploy", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shade-env-"));
    envPath = path.join(tmpDir, ".env");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Anything not in allowed_envs is dropped by the guest anyway, and sending it
  // would count against the guest's limits for nothing.
  it("keeps only the allowed keys, in file order", () => {
    write("B=2\nA=1\nSECRET=x\n");
    expect(loadEnvVarsForDeploy(envPath, ["A", "B"])).toEqual([
      { key: "B", value: "2" },
      { key: "A", value: "1" },
    ]);
  });

  it("keeps everything when no allow list is given", () => {
    write("A=1\nB=2\n");
    expect(loadEnvVarsForDeploy(envPath, null)).toHaveLength(2);
  });

  it("returns [] for a missing file by default", () => {
    expect(loadEnvVarsForDeploy(path.join(tmpDir, "nope"), ["A"])).toEqual([]);
  });

  it("returns [] when no path is given", () => {
    expect(loadEnvVarsForDeploy(undefined, ["A"])).toEqual([]);
  });

  // A self-hosted deploy names env_file_path as required, so a missing file is
  // a mistake rather than "no secrets".
  it("exits 1 for a missing file when requireFile is set", () => {
    expect(() =>
      loadEnvVarsForDeploy(path.join(tmpDir, "nope"), ["A"], {
        requireFile: true,
      }),
    ).toThrow("exit:1");
  });

  it("exits 1 when no path is given and requireFile is set", () => {
    expect(() =>
      loadEnvVarsForDeploy(undefined, ["A"], { requireFile: true }),
    ).toThrow("exit:1");
  });

  it("applies the guest limits to what it loads", () => {
    write("BAD-KEY=1\n");
    expect(() => loadEnvVarsForDeploy(envPath, ["BAD-KEY"])).toThrow("exit:1");
  });
});

describe("validateGuestEnvLimits", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const logged = () => console.log.mock.calls.flat().join(" ");

  it("accepts a normal env set", () => {
    validateGuestEnvLimits(
      [
        { key: "AGENT_CONTRACT_ID", value: "agent.testnet" },
        { key: "_LEADING_UNDERSCORE", value: "ok" },
        { key: "MiXeD9", value: "ok" },
      ],
      "/tmp/.env",
    );
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("exits 1 above 1024 variables", () => {
    const envs = Array.from({ length: 1025 }, (_, i) => ({
      key: `V${i}`,
      value: "x",
    }));
    expect(() => validateGuestEnvLimits(envs, "/tmp/.env")).toThrow("exit:1");
    expect(logged()).toContain("1025");
  });

  it("accepts exactly 1024 variables", () => {
    const envs = Array.from({ length: 1024 }, (_, i) => ({
      key: `V${i}`,
      value: "x",
    }));
    validateGuestEnvLimits(envs, "/tmp/.env");
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("exits 1 above 1 MB in total", () => {
    const envs = Array.from({ length: 16 }, (_, i) => ({
      key: `V${i}`,
      value: "x".repeat(70 * 1024),
    }));
    expect(() => validateGuestEnvLimits(envs, "/tmp/.env")).toThrow("exit:1");
    expect(logged()).toContain("total");
  });

  it("exits 1 above 128 KB in a single value", () => {
    expect(() =>
      validateGuestEnvLimits(
        [{ key: "BIG", value: "x".repeat(128 * 1024 + 1) }],
        "/tmp/.env",
      ),
    ).toThrow("exit:1");
    expect(logged()).toContain("BIG");
  });

  it("exits 1 above a 255-character key", () => {
    expect(() =>
      validateGuestEnvLimits(
        [{ key: `A${"B".repeat(255)}`, value: "x" }],
        "/tmp/.env",
      ),
    ).toThrow("exit:1");
  });

  const badKeys = ["BAD-KEY", "9LEADING", "HAS SPACE", "has.dot", "", "$INJECT"];
  for (const key of badKeys) {
    it(`exits 1 for a key of ${JSON.stringify(key)}`, () => {
      expect(() =>
        validateGuestEnvLimits([{ key, value: "x" }], "/tmp/.env"),
      ).toThrow("exit:1");
    });
  }
});
