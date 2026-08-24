/**
 * Unit tests for src/utils/dstack-deploy.js
 *
 * The invariants here are the ones that decide whether the deployed agent can
 * register: the bytes sent as compose_file must be the bytes that were hashed,
 * the app id allowlisted must be the app id sent, and the CVM must be created
 * in the shape whose rtmr0 the contract approved.
 *
 * Coverage:
 *  - compose_file is byte-identical to the hashed string.
 *  - the allowlisted app id is the one sent to CreateVm, and it is random per
 *    deploy even for an identical compose.
 *  - vcpu/memory come from INSTANCE_TYPE_SHAPES and disk from disk_size_gb.
 *  - GetInfo post-conditions: app-id mismatch, shape mismatch and boot_error
 *    all exit non-zero.
 *  - preflight rejects a missing image and a shape that exceeds VMM capacity.
 *  - gateway_urls is inherited from the VMM when it has one, and sent when not;
 *    a gateway_domain that disagrees with the server is a hard error.
 *  - the app URL uses the published container port.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const vmmRpc = vi.fn();
vi.mock("../../src/utils/dstack-transport.js", () => ({
  vmmRpc: (...args) => vmmRpc(...args),
  VMM_URL: "http://127.0.0.1:10000",
  GATEWAY_RPC_PORT: 9202,
  AUTH_CONFIG_PATH: "/opt/shade/kms/auth-config.json",
}));

const allowlistApp = vi.fn();
vi.mock("../../src/utils/dstack-auth-config.js", () => ({
  allowlistApp: (...args) => allowlistApp(...args),
}));

const getAppEnvEncryptPubKey = vi.fn();
vi.mock("../../src/utils/dstack-kms.js", () => ({
  getAppEnvEncryptPubKey: (...args) => getAppEnvEncryptPubKey(...args),
}));

const { deployToDstack, getAppPort, getInstanceShape } = await import(
  "../../src/utils/dstack-deploy.js"
);
const { hashAppCompose } = await import("../../src/utils/measurements.js");

const COMPOSE_YAML = `services:
  shade-agent-app:
    environment:
      AGENT_CONTRACT_ID: \${AGENT_CONTRACT_ID}
      SPONSOR_PRIVATE_KEY: \${SPONSOR_PRIVATE_KEY}
    image: example/agent@sha256:${"1".repeat(64)}
    container_name: shade-agent-app
    ports:
      - 3000:3000
`;

let tmpDir;
let composePath;
let envPath;

function deployment(overrides = {}) {
  return {
    docker_compose_path: composePath,
    tee_config: {
      backend: "server",
      dstack_version: "0.5.8",
      instance_type: "tdx.small",
      public_logs: true,
      public_sysinfo: true,
      deploy: {
        enabled: true,
        app_name: "my-test-agent",
        env_file_path: envPath,
        ...overrides.deploy,
      },
      server: {
        ssh_host: "tdx",
        gateway_domain: "shade.example.com",
        disk_size_gb: 20,
        ...overrides.server,
      },
    },
    ...overrides.top,
  };
}

// GetMeta / ListImages / CreateVm / GetInfo as the live box answers them.
function mockVmm({ meta, images, createId = "vm-1", info } = {}) {
  const defaults = {
    meta: {
      kms: { urls: ["https://kms.1022.dstack.org:11001"] },
      gateway: {
        base_domain: "shade.example.com",
        urls: ["https://gateway.shade.example.com:9202"],
      },
      resources: { max_allocable_vcpu: 20, max_allocable_memory_in_mb: 100000 },
    },
    images: { images: [{ name: "dstack-0.5.8", version: "0.5.8" }] },
  };
  vmmRpc.mockImplementation((_host, method, params) => {
    if (method === "ListImages") return images ?? defaults.images;
    if (method === "GetMeta") return meta ?? defaults.meta;
    if (method === "CreateVm") return { id: createId };
    if (method === "GetInfo") {
      if (info) return info;
      const create = vmmRpc.mock.calls.find((c) => c[1] === "CreateVm")[2];
      return {
        found: true,
        info: {
          id: createId,
          app_id: create.app_id,
          configuration: { vcpu: create.vcpu, memory: create.memory },
          boot_progress: "booting",
          boot_error: "",
        },
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
}

const createParams = () =>
  vmmRpc.mock.calls.find((c) => c[1] === "CreateVm")[2];

describe("dstack deploy", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shade-dstack-"));
    composePath = path.join(tmpDir, "docker-compose.yaml");
    envPath = path.join(tmpDir, ".env");
    fs.writeFileSync(composePath, COMPOSE_YAML);
    fs.writeFileSync(
      envPath,
      "AGENT_CONTRACT_ID=agent.testnet\nSPONSOR_PRIVATE_KEY=ed25519:secret\nIGNORED=nope\n",
    );

    vmmRpc.mockReset();
    allowlistApp.mockReset().mockReturnValue({ written: true });
    getAppEnvEncryptPubKey
      .mockReset()
      .mockReturnValue(
        crypto
          .generateKeyPairSync("x25519")
          .publicKey.export({ type: "spki", format: "der" })
          .subarray(12)
          .toString("hex"),
      );
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // The VMM hashes the bytes it is handed and never re-serialises, so anything
  // other than the exact hashed string means the approved measurement is wrong.
  it("sends the same compose bytes that were hashed", async () => {
    mockVmm();
    await deployToDstack(deployment());
    const sent = createParams().compose_file;
    expect(hashAppCompose(JSON.parse(sent))).toBe(
      crypto.createHash("sha256").update(sent).digest("hex"),
    );
    expect(sent).toBe(JSON.stringify(JSON.parse(sent)));
  });

  it("allowlists the compose hash of the bytes it sends", async () => {
    mockVmm();
    await deployToDstack(deployment());
    const sent = createParams().compose_file;
    const [, , hash] = allowlistApp.mock.calls[0];
    expect(hash).toBe(crypto.createHash("sha256").update(sent).digest("hex"));
  });

  // An app id that is allowlisted but not deployed means "app not registered"
  // at boot; the reverse means the env cannot be decrypted.
  it("allowlists the app id it sends to CreateVm and encrypts to it", async () => {
    mockVmm();
    const result = await deployToDstack(deployment());
    const [, allowlistedId] = allowlistApp.mock.calls[0];
    expect(allowlistedId).toBe(createParams().app_id);
    expect(allowlistedId).toBe(result.appId);
    expect(getAppEnvEncryptPubKey).toHaveBeenCalledWith("tdx", allowlistedId);
    expect(allowlistedId).toMatch(/^[0-9a-f]{40}$/);
  });

  // KMS keys derive from app_id alone, so two deploys of the same compose must
  // not collide on the disk key or the env key.
  it("uses a different app id for two deploys of an identical compose", async () => {
    mockVmm();
    const first = await deployToDstack(deployment());
    vmmRpc.mockReset();
    mockVmm({ createId: "vm-2" });
    const second = await deployToDstack(deployment());
    expect(first.composeHash).toBe(second.composeHash);
    expect(first.appId).not.toBe(second.appId);
  });

  it("provisions the shape the instance type's measurements were taken for", async () => {
    mockVmm();
    await deployToDstack(deployment());
    const params = createParams();
    const shape = getInstanceShape("tdx.small");
    expect(params.vcpu).toBe(shape.vcpu);
    expect(params.memory).toBe(shape.memoryMb);
    expect(params.disk_size).toBe(20);
    expect(params.image).toBe("dstack-0.5.8");
  });

  it("only sends env vars the compose allows, encrypted", async () => {
    mockVmm();
    await deployToDstack(deployment());
    const params = createParams();
    expect(params.encrypted_env).toMatch(/^[0-9a-f]+$/);
    expect(params.encrypted_env).not.toContain(
      Buffer.from("ed25519:secret").toString("hex"),
    );
    expect(JSON.parse(params.compose_file).allowed_envs).toEqual([
      "AGENT_CONTRACT_ID",
      "SPONSOR_PRIVATE_KEY",
    ]);
  });

  it("points the CVM at the KMS urls the VMM reports", async () => {
    mockVmm();
    await deployToDstack(deployment());
    expect(createParams().kms_urls).toEqual([
      "https://kms.1022.dstack.org:11001",
    ]);
  });

  it("maps no host ports — the CVM is served through the gateway", async () => {
    mockVmm();
    await deployToDstack(deployment());
    expect(createParams().ports).toEqual([]);
  });

  it("reports the app URL on the published container port", async () => {
    mockVmm();
    const result = await deployToDstack(deployment());
    expect(result.appUrl).toBe(
      `https://${result.appId}-3000.shade.example.com`,
    );
  });

  // Inheriting vmm.toml's gateway_urls keeps the VMM console's dashboard link
  // working; sending it per deploy breaks that link.
  it("inherits gateway_urls when the VMM already has one", async () => {
    mockVmm();
    await deployToDstack(deployment());
    expect(createParams().gateway_urls).toBeUndefined();
  });

  it("sends a derived gateway url when the VMM has none", async () => {
    mockVmm({
      meta: {
        kms: { urls: ["https://kms.1022.dstack.org:11001"] },
        gateway: { base_domain: "", urls: [] },
        resources: { max_allocable_vcpu: 20, max_allocable_memory_in_mb: 100000 },
      },
    });
    await deployToDstack(deployment());
    expect(createParams().gateway_urls).toEqual([
      "https://gateway.shade.example.com:9202",
    ]);
  });

  it("exits 1 when gateway_domain disagrees with the server's base domain", async () => {
    mockVmm();
    await expect(
      deployToDstack(
        deployment({ server: { gateway_domain: "wrong.example.com" } }),
      ),
    ).rejects.toThrow("exit:1");
    expect(vmmRpc.mock.calls.some((c) => c[1] === "CreateVm")).toBe(false);
  });

  it("exits 1 when the VMM has no image for the dstack version", async () => {
    mockVmm({ images: { images: [{ name: "dstack-0.5.7" }] } });
    await expect(deployToDstack(deployment())).rejects.toThrow("exit:1");
    expect(allowlistApp).not.toHaveBeenCalled();
  });

  it("exits 1 when the shape exceeds the VMM's capacity", async () => {
    mockVmm({
      meta: {
        kms: { urls: ["https://kms.1022.dstack.org:11001"] },
        gateway: { base_domain: "shade.example.com", urls: [] },
        resources: { max_allocable_vcpu: 1, max_allocable_memory_in_mb: 512 },
      },
    });
    await expect(deployToDstack(deployment())).rejects.toThrow("exit:1");
    expect(allowlistApp).not.toHaveBeenCalled();
  });

  it("exits 1 when the VMM has no kms_urls", async () => {
    mockVmm({
      meta: {
        kms: { urls: [] },
        gateway: { base_domain: "shade.example.com", urls: [] },
        resources: { max_allocable_vcpu: 20, max_allocable_memory_in_mb: 100000 },
      },
    });
    await expect(deployToDstack(deployment())).rejects.toThrow("exit:1");
  });

  // This is the check that catches "approved one shape, deployed another".
  it("exits 1 when GetInfo reports a different shape than requested", async () => {
    mockVmm({
      info: {
        found: true,
        info: {
          app_id: "ignored",
          configuration: { vcpu: 32, memory: 32768 },
          boot_error: "",
        },
      },
    });
    await expect(deployToDstack(deployment())).rejects.toThrow("exit:1");
  });

  it("exits 1 when GetInfo reports a different app id than requested", async () => {
    mockVmm({
      info: {
        found: true,
        info: {
          app_id: "ff".repeat(20),
          configuration: { vcpu: 1, memory: 2048 },
          boot_error: "",
        },
      },
    });
    await expect(deployToDstack(deployment())).rejects.toThrow("exit:1");
  });

  it("exits 1 and surfaces boot_error when the CVM failed to boot", async () => {
    const logSpy = vi.spyOn(console, "log");
    vmmRpc.mockImplementation((_host, method) => {
      if (method === "ListImages") return { images: [{ name: "dstack-0.5.8" }] };
      if (method === "GetMeta")
        return {
          kms: { urls: ["https://kms.1022.dstack.org:11001"] },
          gateway: { base_domain: "shade.example.com", urls: [] },
          resources: { max_allocable_vcpu: 20, max_allocable_memory_in_mb: 100000 },
        };
      if (method === "CreateVm") return { id: "vm-1" };
      const create = vmmRpc.mock.calls.find((c) => c[1] === "CreateVm")[2];
      return {
        found: true,
        info: {
          app_id: create.app_id,
          configuration: { vcpu: create.vcpu, memory: create.memory },
          boot_error: "no space left on device",
        },
      };
    });
    await expect(deployToDstack(deployment())).rejects.toThrow("exit:1");
    expect(logSpy.mock.calls.flat().join(" ")).toContain("no space left on device");
  });

  it("exits 1 when the env file is missing", async () => {
    mockVmm();
    fs.rmSync(envPath);
    await expect(deployToDstack(deployment())).rejects.toThrow("exit:1");
  });

  // Local failures must happen before anything is allowlisted or created,
  // otherwise a bad compose orphans a running CVM plus its allowlist entry.
  it("bails before touching the server when the env file is missing", async () => {
    mockVmm();
    fs.rmSync(envPath);
    await expect(deployToDstack(deployment())).rejects.toThrow("exit:1");
    expect(allowlistApp).not.toHaveBeenCalled();
    expect(vmmRpc.mock.calls.some((c) => c[1] === "CreateVm")).toBe(false);
  });

  // A signer that isn't this KMS must abort before the allowlist is written,
  // not after — otherwise a rejected key leaves an entry for an app id that
  // will never be deployed.
  it("bails before the allowlist write when the env key fails to verify", async () => {
    mockVmm();
    getAppEnvEncryptPubKey.mockImplementation(() => {
      throw new Error("exit:1");
    });
    await expect(deployToDstack(deployment())).rejects.toThrow("exit:1");
    expect(allowlistApp).not.toHaveBeenCalled();
    expect(vmmRpc.mock.calls.some((c) => c[1] === "CreateVm")).toBe(false);
  });

  it("bails before touching the server when the compose publishes no port", async () => {
    mockVmm();
    fs.writeFileSync(
      composePath,
      COMPOSE_YAML.replace(/    ports:\n      - 3000:3000\n/, ""),
    );
    await expect(deployToDstack(deployment())).rejects.toThrow("exit:1");
    expect(allowlistApp).not.toHaveBeenCalled();
    expect(vmmRpc.mock.calls.some((c) => c[1] === "CreateVm")).toBe(false);
  });
});

describe("getAppPort", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shade-port-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(portsYaml) {
    const p = path.join(tmpDir, "docker-compose.yaml");
    fs.writeFileSync(
      p,
      `services:\n  shade-agent-app:\n    image: x\n${portsYaml}`,
    );
    return p;
  }

  it("reads the host side of a short mapping", () => {
    expect(getAppPort(write("    ports:\n      - 3000:3000\n"))).toBe("3000");
    expect(getAppPort(write("    ports:\n      - 8080:3000\n"))).toBe("8080");
  });

  it("reads the host side of an ip-qualified mapping", () => {
    expect(getAppPort(write("    ports:\n      - 0.0.0.0:8080:3000\n"))).toBe("8080");
  });

  it("ignores a protocol suffix", () => {
    expect(getAppPort(write("    ports:\n      - 3000:3000/tcp\n"))).toBe("3000");
  });

  it("accepts a container-only port", () => {
    expect(getAppPort(write('    ports:\n      - "3000"\n'))).toBe("3000");
  });

  it("exits 1 when the service publishes no ports", () => {
    expect(() => getAppPort(write("    restart: always\n"))).toThrow("exit:1");
  });

  it("exits 1 when the service is missing", () => {
    const p = path.join(tmpDir, "other.yaml");
    fs.writeFileSync(p, "services:\n  other:\n    image: x\n");
    expect(() => getAppPort(p)).toThrow("exit:1");
  });
});

describe("getInstanceShape", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  // tdx.small is the only shape documented by Phala; the rest double.
  it("returns 1 vcpu / 2048 MB for tdx.small", () => {
    expect(getInstanceShape("tdx.small")).toEqual({ vcpu: 1, memoryMb: 2048 });
  });

  it("doubles upward through the instance types", () => {
    expect(getInstanceShape("tdx.medium")).toEqual({ vcpu: 2, memoryMb: 4096 });
    expect(getInstanceShape("tdx.8xlarge")).toEqual({ vcpu: 64, memoryMb: 131072 });
  });

  it("exits 1 for an unknown instance type", () => {
    expect(() => getInstanceShape("tdx.enormous")).toThrow("exit:1");
  });
});
