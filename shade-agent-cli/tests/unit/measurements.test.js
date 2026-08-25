/**
 * Unit tests for src/utils/measurements.js
 *
 * Coverage:
 *  - hashAppCompose: deterministic over identical inputs; differs on any change;
 *    returns a 64-char hex digest.
 *  - buildAppComposeForDeploy: returns the canonical 17-field shape Phala
 *    expects, in alphabetical key order.
 *  - extractAllowedEnvs: picks ${VAR} from object-syntax `environment:`;
 *    returns [] when no environment is set; ignores non-${VAR} values;
 *    currently DOES NOT pick from array-syntax.
 *  - calculateAppComposeHash: deterministic for the same docker-compose
 *    content.
 *
 * Notes:
 *  - The prelaunch script is read from disk at module load — that file is
 *    real (committed in this repo), so we don't need to mock it here.
 *  - fs.readFileSync is spied per-test for the docker-compose content.
 *  - dstack-kms is mocked, so the self-hosted digest lookup is observable
 *    without a server.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import crypto from "crypto";
import path from "path";
import os from "os";

const getKeyProviderEventDigest = vi.fn(() => "cd".repeat(48));
vi.mock("../../src/utils/dstack-kms.js", () => ({
  getKeyProviderEventDigest: (...args) => getKeyProviderEventDigest(...args),
}));

import {
  hashAppCompose,
  buildAppComposeForDeploy,
  extractAllowedEnvs,
  calculateAppComposeHash,
  prepareAppCompose,
  prepareAppComposeFromParts,
  getMeasurements,
  INSTANCE_TYPE_SHAPES,
  PHALA_KEY_PROVIDER_EVENT_DIGEST,
} from "../../src/utils/measurements.js";

describe("hashAppCompose", () => {
  // Stability: hashing the same object twice yields the same digest.
  it("is deterministic for the same input", () => {
    const obj = { a: 1, b: ["x"] };
    expect(hashAppCompose(obj)).toBe(hashAppCompose(obj));
  });

  // Sensitivity: a single-field change produces a different digest.
  it("differs when any field changes", () => {
    expect(hashAppCompose({ a: 1 })).not.toBe(hashAppCompose({ a: 2 }));
  });

  // The output is the standard 64-char hex SHA-256.
  it("returns a 64-character hex string", () => {
    expect(hashAppCompose({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("buildAppComposeForDeploy", () => {
  // Locks the canonical 17-field shape Phala hashes — drift here breaks
  // compose_hash matching and the audit's hash-compare assertion.
  it("returns the expected 17-field object in alphabetical order", () => {
    const out = buildAppComposeForDeploy("services: foo", ["A", "B"], {
      publicLogs: true,
      publicSysinfo: true,
    });
    expect(Object.keys(out)).toEqual([
      "allowed_envs",
      "docker_compose_file",
      "features",
      "gateway_enabled",
      "kms_enabled",
      "local_key_provider_enabled",
      "manifest_version",
      "name",
      "no_instance_id",
      "pre_launch_script",
      "public_logs",
      "public_sysinfo",
      "public_tcbinfo",
      "runner",
      "secure_time",
      "storage_fs",
      "tproxy_enabled",
    ]);
    expect(out.allowed_envs).toEqual(["A", "B"]);
    expect(out.docker_compose_file).toBe("services: foo");
    expect(out.manifest_version).toBe(2);
    expect(out.runner).toBe("docker-compose");
    expect(out.public_logs).toBe(true);
    expect(out.public_sysinfo).toBe(true);
  });

  // Both flags propagate as `false` when explicitly disabled.
  it("propagates publicLogs:false and publicSysinfo:false into the compose object", () => {
    const out = buildAppComposeForDeploy("services: foo", [], {
      publicLogs: false,
      publicSysinfo: false,
    });
    expect(out.public_logs).toBe(false);
    expect(out.public_sysinfo).toBe(false);
  });

  // Flipping either flag must change the compose-hash so reproducibility holds.
  it("produces a different hash when public_logs or public_sysinfo flips", () => {
    const both = buildAppComposeForDeploy("services: foo", ["A"], {
      publicLogs: true,
      publicSysinfo: true,
    });
    const logsOff = buildAppComposeForDeploy("services: foo", ["A"], {
      publicLogs: false,
      publicSysinfo: true,
    });
    const sysinfoOff = buildAppComposeForDeploy("services: foo", ["A"], {
      publicLogs: true,
      publicSysinfo: false,
    });
    expect(hashAppCompose(both)).not.toBe(hashAppCompose(logsOff));
    expect(hashAppCompose(both)).not.toBe(hashAppCompose(sysinfoOff));
    expect(hashAppCompose(logsOff)).not.toBe(hashAppCompose(sysinfoOff));
  });

  // Missing options should error+exit at the site of the failure (CLI convention).
  it("exits 1 when publicLogs or publicSysinfo is missing", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => buildAppComposeForDeploy("services: foo", [])).toThrow("exit:1");
    expect(() =>
      buildAppComposeForDeploy("services: foo", [], { publicLogs: true }),
    ).toThrow("exit:1");
    expect(() =>
      buildAppComposeForDeploy("services: foo", [], { publicSysinfo: false }),
    ).toThrow("exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe("extractAllowedEnvs", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  // Object-syntax (the supported form): a `${VAR}` reference yields VAR in
  // the allowed list.
  it("picks ${VAR} from object-syntax environment:", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(`
services:
  app:
    environment:
      FOO: \${FOO}
      BAR: literal
`);
    expect(extractAllowedEnvs("/fake/path")).toEqual(["FOO"]);
  });

  // No environment field → empty list.
  it("returns [] when no service has environment", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      "services:\n  app:\n    image: x",
    );
    expect(extractAllowedEnvs("/fake/path")).toEqual([]);
  });

  // Non-${VAR} values aren't allow-listed — only literal env-var refs.
  it("ignores object-syntax values that aren't ${VAR} references", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(`
services:
  app:
    environment:
      FOO: hardcoded
      BAR: \${BAR}
`);
    expect(extractAllowedEnvs("/fake/path")).toEqual(["BAR"]);
  });
});

describe("calculateAppComposeHash", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  // Two reads of the same docker-compose content must produce the same hash —
  // any drift here breaks Phala approval matching.
  it("is deterministic for the same docker-compose content", () => {
    const content = `services:
  app:
    environment:
      FOO: \${FOO}
`;
    const spy = vi.spyOn(fs, "readFileSync").mockReturnValue(content);
    const h1 = calculateAppComposeHash("/fake/path", {
      publicLogs: true,
      publicSysinfo: true,
    });
    const h2 = calculateAppComposeHash("/fake/path", {
      publicLogs: true,
      publicSysinfo: true,
    });
    expect(h1).toBe(h2);
    spy.mockRestore();
  });

  // The two new flags must round-trip through to the hash so verifiers running
  // `shade reproduce` against a deployment.yaml with public_logs:false get a
  // matching hash.
  it("produces a different hash when public_logs or public_sysinfo differ", () => {
    const content = "services:\n  app:\n    image: x";
    const spy = vi.spyOn(fs, "readFileSync").mockReturnValue(content);
    const onOn = calculateAppComposeHash("/fake/path", {
      publicLogs: true,
      publicSysinfo: true,
    });
    const offOff = calculateAppComposeHash("/fake/path", {
      publicLogs: false,
      publicSysinfo: false,
    });
    expect(onOn).not.toBe(offOff);
    spy.mockRestore();
  });
});

describe("prepareAppComposeFromParts", () => {
  // The compose bytes a self-hosted deploy sends must be the exact bytes the
  // hash was taken over — the VMM hashes what it is given and never
  // re-serialises.
  it("returns a JSON string whose sha256 is the returned hash", () => {
    const content = "services:\n  app:\n    image: x";
    const { appCompose, composeJson, composeHash } = prepareAppComposeFromParts(
      content,
      ["FOO"],
      { publicLogs: true, publicSysinfo: true },
    );
    expect(composeJson).toBe(JSON.stringify(appCompose));
    expect(
      crypto.createHash("sha256").update(composeJson).digest("hex"),
    ).toBe(composeHash);
  });

  // calculateAppComposeHash now routes through the same helper, so the two
  // must never diverge.
  it("agrees with calculateAppComposeHash and hashAppCompose", () => {
    const content = `services:
  app:
    environment:
      FOO: \${FOO}
`;
    const spy = vi.spyOn(fs, "readFileSync").mockReturnValue(content);
    const viaPath = calculateAppComposeHash("/fake/path", {
      publicLogs: true,
      publicSysinfo: true,
    });
    spy.mockRestore();
    const prepared = prepareAppComposeFromParts(content, ["FOO"], {
      publicLogs: true,
      publicSysinfo: true,
    });
    expect(prepared.composeHash).toBe(viaPath);
    expect(hashAppCompose(prepared.appCompose)).toBe(viaPath);
  });
});

describe("prepareAppCompose", () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shade-prepare-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("drives the compose off docker_compose_path and tee_config", () => {
    const composePath = path.join(tmpDir, "docker-compose.yaml");
    fs.writeFileSync(
      composePath,
      "services:\n  app:\n    environment:\n      FOO: ${FOO}\n",
    );
    const { allowedEnvs, composeHash } = prepareAppCompose({
      docker_compose_path: composePath,
      tee_config: { public_logs: true, public_sysinfo: true },
    });
    expect(allowedEnvs).toEqual(["FOO"]);
    expect(composeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("exits 1 when the compose file is missing", () => {
    expect(() =>
      prepareAppCompose({
        docker_compose_path: path.join(tmpDir, "nope.yaml"),
        tee_config: { public_logs: true, public_sysinfo: true },
      }),
    ).toThrow("exit:1");
  });
});

describe("key_provider_event_digest", () => {
  beforeEach(() => {
    getKeyProviderEventDigest.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const composeContent = "services:\n  app:\n    image: x";

  const tee = (backend) => ({
    environment: "TEE",
    docker_compose_path: "/fake/path",
    tee_config: {
      backend,
      dstack_version: "0.5.8",
      instance_type: "tdx.small",
      public_logs: true,
      public_sysinfo: true,
      server: { ssh_host: "tdx" },
    },
  });

  // Regression guard: the Phala path must stay byte-identical, and Phala's
  // digest is a pinned constant, so it must not reach for a server.
  it("uses Phala's constant for the phala backend, without an SSH call", () => {
    const spy = vi.spyOn(fs, "readFileSync").mockReturnValue(composeContent);
    const measurements = getMeasurements(tee("phala"));
    spy.mockRestore();
    expect(measurements.key_provider_event_digest).toBe(
      PHALA_KEY_PROVIDER_EVENT_DIGEST,
    );
    expect(measurements.rtmrs.rtmr0).toBe(
      "68102e7b524af310f7b7d426ce75481e36c40f5d513a9009c046e9d37e31551f0134d954b496a3357fd61d03f07ffe96",
    );
    expect(getKeyProviderEventDigest).not.toHaveBeenCalled();
  });

  // A self-hosted server has its own KMS, so the digest is per-operator.
  it("reads the digest off the server's KMS for the server backend", () => {
    const spy = vi.spyOn(fs, "readFileSync").mockReturnValue(composeContent);
    const measurements = getMeasurements(tee("server"));
    spy.mockRestore();
    expect(measurements.key_provider_event_digest).toBe("cd".repeat(48));
    expect(getKeyProviderEventDigest).toHaveBeenCalledWith("tdx");
  });

  // Local mode is all zeros, and has no KMS to ask.
  it("returns zeros in local mode without an SSH call", () => {
    const measurements = getMeasurements({ environment: "LOCAL" });
    expect(measurements.key_provider_event_digest).toBe("0".repeat(96));
    expect(getKeyProviderEventDigest).not.toHaveBeenCalled();
  });

  // A bad deployment.yaml must fail before anything waits on the server.
  it("rejects a missing instance_type before touching the KMS", () => {
    const deployment = tee("server");
    delete deployment.tee_config.instance_type;
    expect(() => getMeasurements(deployment)).toThrow("exit:1");
    expect(getKeyProviderEventDigest).not.toHaveBeenCalled();
  });
});

describe("INSTANCE_TYPE_SHAPES", () => {
  // rtmr0 measures vcpu and memory, so a self-hosted CVM has to be created in
  // the shape the table's row was measured for. Every instance type the
  // measurement table knows about needs a shape.
  it("covers every instance type in the measurement table", async () => {
    const { hardwareAndOSMeasurements } = await import(
      "../../src/utils/measurements.js"
    );
    for (const version of Object.keys(hardwareAndOSMeasurements)) {
      for (const instanceType of Object.keys(hardwareAndOSMeasurements[version])) {
        expect(INSTANCE_TYPE_SHAPES[instanceType]).toBeDefined();
      }
    }
  });

  it("starts at 1 vcpu / 2048 MB and doubles", () => {
    expect(INSTANCE_TYPE_SHAPES["tdx.small"]).toEqual({ vcpu: 1, memoryMb: 2048 });
    const types = [
      "tdx.small",
      "tdx.medium",
      "tdx.large",
      "tdx.xlarge",
      "tdx.2xlarge",
      "tdx.4xlarge",
      "tdx.8xlarge",
    ];
    for (let i = 1; i < types.length; i++) {
      expect(INSTANCE_TYPE_SHAPES[types[i]].vcpu).toBe(
        INSTANCE_TYPE_SHAPES[types[i - 1]].vcpu * 2,
      );
      expect(INSTANCE_TYPE_SHAPES[types[i]].memoryMb).toBe(
        INSTANCE_TYPE_SHAPES[types[i - 1]].memoryMb * 2,
      );
    }
  });

  // Memory is in MB because that is what CreateVm.memory takes; a bare "2"
  // would be 2 megabytes.
  it("expresses memory in MB", () => {
    for (const shape of Object.values(INSTANCE_TYPE_SHAPES)) {
      expect(shape.memoryMb).toBe(shape.vcpu * 2048);
    }
  });
});
