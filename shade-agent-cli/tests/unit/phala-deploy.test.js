/**
 * Unit tests for src/utils/phala-deploy.js — config flow into the Phala SDK.
 *
 * Coverage:
 *  - deployToPhala invokes provisionCvm with the dstackVersion / instanceType /
 *    appName from options (no defaults, no implicit substitutions).
 *  - Required fields (dstackVersion, instanceType) throw when missing.
 *  - appName must be longer than 3 chars.
 *  - When Phala-returned compose_hash mismatches the locally computed hash,
 *    the helper renders a red error and exits 1
 *
 * Notes:
 *  - @phala/cloud is fully mocked via a hoisted shared client.
 *  - fs is mocked at the file level (compose-file content + the prelaunch
 *    script that measurements.js loads at module init).
 *  - process.exit is spied so the abort path is observable.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockClient } = vi.hoisted(() => ({
  mockClient: {
    provisionCvm: vi.fn(),
    commitCvmProvision: vi.fn(),
  },
}));

vi.mock("@phala/cloud", () => ({
  createClient: vi.fn(() => mockClient),
  deployAppAuth: vi.fn(),
  encryptEnvVars: vi.fn(async () => []),
  parseEnvVars: vi.fn(() => []),
}));

const composeContent = "services:\n  app:\n    image: x\n";

const { deployToPhala } = await import("../../src/utils/phala-deploy.js");
const { buildAppComposeForDeploy, hashAppCompose } = await import(
  "../../src/utils/measurements.js"
);
const fs = (await import("fs")).default;

describe("deployToPhala", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Stub compose-file existence and content (measurements.js reads the
    // prelaunch.sh from real disk — that file ships with the CLI source).
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockImplementation((p) => {
      if (typeof p === "string" && p.endsWith("docker-compose.yaml")) {
        return composeContent;
      }
      // For everything else (including the prelaunch.sh path), defer to real
      // fs by throwing — but vitest's spyOn won't recurse, so return a
      // sensible default instead.
      return "";
    });
  });

  // YAML values must reach Phala as-is. Verifies provisionCvm is called with
  // the exact name / instance_type / image we passed in.
  it("passes appName, instanceType, and dstack image to provisionCvm", async () => {
    const compose = buildAppComposeForDeploy(composeContent, []);
    mockClient.provisionCvm.mockResolvedValue({
      app_id: "app-1",
      app_env_encrypt_pubkey: "pubkey",
      compose_hash: hashAppCompose(compose),
    });
    mockClient.commitCvmProvision.mockResolvedValue({
      vm_uuid: "vm-abc",
      name: "my-app",
      app_id: "app-1",
    });

    await deployToPhala({
      appName: "my-app",
      apiKey: "key",
      composePath: "./docker-compose.yaml",
      dstackVersion: "0.5.7",
      instanceType: "tdx.medium",
    });

    const provisionArgs = mockClient.provisionCvm.mock.calls[0][0];
    expect(provisionArgs.name).toBe("my-app");
    expect(provisionArgs.instance_type).toBe("tdx.medium");
    expect(provisionArgs.image).toBe("dstack-0.5.7");
  });

  // dstack_version is required.
  it("exits 1 when dstackVersion is missing", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(
      deployToPhala({
        appName: "my-app",
        apiKey: "key",
        composePath: "./docker-compose.yaml",
        instanceType: "tdx.small",
      }),
    ).rejects.toThrow("exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // instance_type is required.
  it("exits 1 when instanceType is missing", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(
      deployToPhala({
        appName: "my-app",
        apiKey: "key",
        composePath: "./docker-compose.yaml",
        dstackVersion: "0.5.7",
      }),
    ).rejects.toThrow("exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // appName must be longer than 3 chars.
  it("exits 1 on appName.length <= 3", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(
      deployToPhala({
        appName: "abc",
        apiKey: "key",
        composePath: "./docker-compose.yaml",
        dstackVersion: "0.5.7",
        instanceType: "tdx.small",
      }),
    ).rejects.toThrow("exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // When provision.compose_hash differs from the locally
  // computed hash, the helper aborts via process.exit(1).
  it("exits 1 when Phala compose_hash diverges from the locally computed hash", async () => {
    mockClient.provisionCvm.mockResolvedValue({
      app_id: "app-1",
      app_env_encrypt_pubkey: "pubkey",
      compose_hash: "0".repeat(64), // intentionally wrong
    });
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code) => {
        throw new Error(`exit:${code}`);
      });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      deployToPhala({
        appName: "my-app",
        apiKey: "key",
        composePath: "./docker-compose.yaml",
        dstackVersion: "0.5.7",
        instanceType: "tdx.small",
      }),
    ).rejects.toThrow("exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
