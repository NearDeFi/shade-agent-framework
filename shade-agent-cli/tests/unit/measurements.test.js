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
 *    currently DOES NOT pick from array-syntax (SAF P4A gap).
 *  - calculateAppComposeHash: deterministic for the same docker-compose
 *    content.
 *
 * Notes:
 *  - The prelaunch script is read from disk at module load — that file is
 *    real (committed in this repo), so we don't need to mock it here.
 *  - fs.readFileSync is spied per-test for the docker-compose content.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import {
  hashAppCompose,
  buildAppComposeForDeploy,
  extractAllowedEnvs,
  calculateAppComposeHash,
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
    const out = buildAppComposeForDeploy("services: foo", ["A", "B"]);
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

  // Documented gap (SAF P4A): array-syntax environment is silently dropped.
  // Asserting current behavior so a future fix has to update this test.
  it("currently does NOT pick from array-syntax environment (SAF P4A gap)", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(`
services:
  app:
    environment:
      - FOO=\${FOO}
`);
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
    const h1 = calculateAppComposeHash("/fake/path");
    const h2 = calculateAppComposeHash("/fake/path");
    expect(h1).toBe(h2);
    spy.mockRestore();
  });
});
