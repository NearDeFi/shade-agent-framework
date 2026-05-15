/**
 * Unit tests for src/utils/config.js — parseDeploymentConfig.
 *
 * Three concerns:
 *   - examples:   every committed example-{1..10}.yaml parses without exit.
 *                 Regression guard: catches the case where a future required
 *                 field is added but an example isn't updated.
 *   - validation: missing / wrong-shape inputs in *generated* YAML fixtures
 *                 render chalk.red and exit 1, with the expected diagnostic
 *                 substring.
 *   - mapping:    accepted values in *generated* YAML fixtures land at the
 *                 expected paths in the returned config object (including
 *                 sections that intentionally collapse to `undefined`).
 *
 * Approach:
 *   - The "examples" describe reads the real committed files in
 *     example-deployment-files/ — no fixture generation.
 *   - Validation and mapping describes generate synthetic YAML on the fly
 *     via validYaml(overrides) and write it to a tmp file per test. The
 *     parser uses named imports of fs.readFileSync / fs.existsSync that
 *     vi.spyOn cannot intercept, so mocking fs is unreliable; tmp files
 *     run the real I/O path.
 *   - process.exit and console.log are spied per test so abort paths are
 *     observable and the red diagnostic is asserted by substring match.
 *   - validYaml(overrides) deep-merges into a known-good baseline so each
 *     test can mutate just the slice it cares about. Setting a key to
 *     `undefined` in overrides deletes it; `null` keeps it but yields a
 *     parser-visible "missing" value (`!!null === false`, `typeof null
 *     !== "boolean"`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { stringify } from "yaml";

const { parseDeploymentConfig } = await import("../../src/utils/config.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesDir = path.resolve(
  __dirname,
  "..",
  "..",
  "example-deployment-files",
);

// Minimal valid baseline: TEE + testnet, deploy_custom and build_docker_image
// disabled so unrelated validations don't fire. Tests override slices via
// validYaml({ ... }).
const validBase = () => ({
  environment: "TEE",
  network: "testnet",
  docker_compose_path: "./docker-compose.yaml",
  agent_contract: {
    contract_id: "example-contract-123.testnet",
    deploy_custom: { enabled: false },
  },
  build_docker_image: { enabled: false },
  deploy_to_phala: {
    enabled: true,
    app_name: "my-agent",
    env_file_path: "./.env",
    dstack_version: "0.5.8",
    instance_type: "tdx.small",
    public_logs: true,
    public_sysinfo: true,
  },
});

function deepMerge(base, overrides) {
  if (overrides === null) return null;
  if (
    typeof base !== "object" ||
    typeof overrides !== "object" ||
    base === null ||
    Array.isArray(base) ||
    Array.isArray(overrides)
  ) {
    return overrides;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      delete out[k];
    } else {
      out[k] = deepMerge(base[k], v);
    }
  }
  return out;
}

const validYaml = (overrides = {}) =>
  stringify(deepMerge(validBase(), overrides));

let tmpDir;
let yamlPath;
let exitSpy;
let logSpy;

function parse(yaml) {
  fs.writeFileSync(yamlPath, yaml, "utf8");
  return parseDeploymentConfig(yamlPath);
}

function expectExit(yaml, msgSubstring) {
  fs.writeFileSync(yamlPath, yaml, "utf8");
  expect(() => parseDeploymentConfig(yamlPath)).toThrow("exit:1");
  expect(exitSpy).toHaveBeenCalledWith(1);
  if (msgSubstring) {
    const allLogs = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allLogs).toContain(msgSubstring);
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shade-config-test-"));
  yamlPath = path.join(tmpDir, "deployment.yaml");
  exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit:${code}`);
  });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Reusable valid sub-blocks so individual test overrides stay readable.
const validDeployCustom = {
  enabled: true,
  funding_amount: 8,
  delete_key: false,
  deploy_from_source: { enabled: false },
  deploy_from_wasm: { enabled: false },
  use_global_by_hash: { enabled: true, global_hash: "abc123" },
};

const VALID_MULTILINE_ARGS = '{\n  "key": "value"\n}\n';

const validApproveMeasurements = {
  enabled: true,
  method_name: "approve_measurements",
  args: VALID_MULTILINE_ARGS,
};

const validApprovePpids = {
  enabled: true,
  method_name: "approve_ppids",
  args: VALID_MULTILINE_ARGS,
};

const validBuildDockerImage = {
  enabled: true,
  tag: "username/my-agent",
  cache: true,
  dockerfile_path: "./Dockerfile",
};

describe("parseDeploymentConfig", () => {
  // Regression guard: every committed example must remain parser-valid. If a
  // future required field is added without updating an example, this fails.
  describe("examples", () => {
    const exampleFiles = Array.from(
      { length: 10 },
      (_, i) => `example-${i + 1}.yaml`,
    );
    it.each(exampleFiles)("%s parses without exit", (name) => {
      const filePath = path.resolve(examplesDir, name);
      expect(() => parseDeploymentConfig(filePath)).not.toThrow();
    });
  });

  describe("environment", () => {
    describe("validation", () => {
      it("exits 1 when missing", () => {
        expectExit(
          validYaml({ environment: undefined }),
          "environment is required",
        );
      });

      it("exits 1 when set to an unsupported value", () => {
        expectExit(
          validYaml({ environment: "staging" }),
          "environment must be one of: local, TEE",
        );
      });
    });

    describe("mapping", () => {
      it("propagates environment: TEE", () => {
        const config = parse(validYaml({ environment: "TEE" }));
        expect(config.environment).toBe("TEE");
      });

      it("propagates environment: local (no docker_compose_path required)", () => {
        const config = parse(
          validYaml({
            environment: "local",
            docker_compose_path: undefined,
          }),
        );
        expect(config.environment).toBe("local");
      });
    });
  });

  describe("network", () => {
    describe("validation", () => {
      it("exits 1 when missing", () => {
        expectExit(
          validYaml({ network: undefined }),
          "network is required",
        );
      });

      it("exits 1 when set to an unsupported value", () => {
        expectExit(
          validYaml({ network: "devnet" }),
          "network must be one of: testnet, mainnet",
        );
      });
    });

    describe("mapping", () => {
      it.each([["testnet"], ["mainnet"]])(
        "propagates network: %s",
        (network) => {
          const config = parse(validYaml({ network }));
          expect(config.network).toBe(network);
        },
      );
    });
  });

  describe("os", () => {
    describe("validation", () => {
      it("exits 1 when set to an unsupported value", () => {
        expectExit(
          validYaml({ os: "windows" }),
          "os must be one of: mac, linux",
        );
      });
    });

    describe("mapping", () => {
      it.each([["mac"], ["linux"]])("propagates os: %s when set", (osValue) => {
        const config = parse(validYaml({ os: osValue }));
        expect(config.os).toBe(osValue);
      });

      it("auto-detects when omitted (returns mac or linux)", () => {
        const config = parse(validYaml({ os: undefined }));
        expect(["mac", "linux"]).toContain(config.os);
      });
    });
  });

  describe("docker_compose_path", () => {
    describe("validation", () => {
      it("exits 1 on TEE when missing", () => {
        expectExit(
          validYaml({ docker_compose_path: undefined }),
          "docker_compose_path is required",
        );
      });

      it("not required on local", () => {
        const config = parse(
          validYaml({
            environment: "local",
            docker_compose_path: undefined,
          }),
        );
        expect(config.docker_compose_path).toBeUndefined();
      });
    });

    describe("mapping", () => {
      it("propagates the path verbatim", () => {
        const config = parse(
          validYaml({ docker_compose_path: "./compose/prod.yaml" }),
        );
        expect(config.docker_compose_path).toBe("./compose/prod.yaml");
      });
    });
  });

  describe("agent_contract.contract_id", () => {
    describe("validation", () => {
      it("exits 1 when agent_contract is missing entirely", () => {
        expectExit(
          validYaml({ agent_contract: undefined }),
          "agent_contract is required",
        );
      });

      it("exits 1 when contract_id is missing", () => {
        expectExit(
          validYaml({ agent_contract: { contract_id: null } }),
          "agent_contract.contract_id is required",
        );
      });
    });

    describe("mapping", () => {
      it("propagates contract_id", () => {
        const config = parse(
          validYaml({
            agent_contract: { contract_id: "owner.testnet" },
          }),
        );
        expect(config.agent_contract.contract_id).toBe("owner.testnet");
      });
    });
  });

  describe("agent_contract.deploy_custom", () => {
    describe("validation", () => {
      it("exits 1 when funding_amount is not a number", () => {
        expectExit(
          validYaml({
            agent_contract: {
              deploy_custom: { ...validDeployCustom, funding_amount: "8" },
            },
          }),
          "deploy_custom.funding_amount must be a number > 0 and <= 100",
        );
      });

      it.each([[0], [-5], [101], [1000]])(
        "exits 1 when funding_amount is %i (out of range)",
        (amount) => {
          expectExit(
            validYaml({
              agent_contract: {
                deploy_custom: { ...validDeployCustom, funding_amount: amount },
              },
            }),
            "deploy_custom.funding_amount must be a number > 0 and <= 100",
          );
        },
      );

      it("exits 1 when none of source / wasm / global is enabled", () => {
        expectExit(
          validYaml({
            agent_contract: {
              deploy_custom: {
                ...validDeployCustom,
                use_global_by_hash: { enabled: false },
              },
            },
          }),
          "deploy_custom must specify exactly one of",
        );
      });

      it("exits 1 when two of source / wasm / global are enabled", () => {
        expectExit(
          validYaml({
            agent_contract: {
              deploy_custom: {
                ...validDeployCustom,
                deploy_from_wasm: { enabled: true, wasm_path: "./out.wasm" },
                // use_global_by_hash also enabled in baseline
              },
            },
          }),
          "deploy_custom must specify exactly one of",
        );
      });

      it("exits 1 when deploy_from_source enabled without source_path", () => {
        expectExit(
          validYaml({
            agent_contract: {
              deploy_custom: {
                ...validDeployCustom,
                deploy_from_source: { enabled: true },
                use_global_by_hash: { enabled: false },
              },
            },
          }),
          "deploy_custom.deploy_from_source.source_path is required",
        );
      });

      it("exits 1 when deploy_from_source.reproducible_build is non-boolean", () => {
        expectExit(
          validYaml({
            agent_contract: {
              deploy_custom: {
                ...validDeployCustom,
                deploy_from_source: {
                  enabled: true,
                  source_path: "./contract",
                  reproducible_build: "yes",
                },
                use_global_by_hash: { enabled: false },
              },
            },
          }),
          "deploy_custom.deploy_from_source.reproducible_build must be a boolean (true or false) if specified",
        );
      });

      it("exits 1 when deploy_from_wasm enabled without wasm_path", () => {
        expectExit(
          validYaml({
            agent_contract: {
              deploy_custom: {
                ...validDeployCustom,
                deploy_from_wasm: { enabled: true },
                use_global_by_hash: { enabled: false },
              },
            },
          }),
          "deploy_custom.deploy_from_wasm.wasm_path is required",
        );
      });

      it("exits 1 when use_global_by_hash enabled without global_hash", () => {
        expectExit(
          validYaml({
            agent_contract: {
              deploy_custom: {
                ...validDeployCustom,
                use_global_by_hash: { enabled: true, global_hash: null },
              },
            },
          }),
          "deploy_custom.use_global_by_hash.global_hash is required",
        );
      });

      it("exits 1 when init enabled without method_name", () => {
        expectExit(
          validYaml({
            agent_contract: {
              deploy_custom: {
                ...validDeployCustom,
                init: { enabled: true, args: VALID_MULTILINE_ARGS },
              },
            },
          }),
          "deploy_custom.init.method_name is required",
        );
      });

      it("exits 1 when init enabled without args", () => {
        expectExit(
          validYaml({
            agent_contract: {
              deploy_custom: {
                ...validDeployCustom,
                init: { enabled: true, method_name: "new" },
              },
            },
          }),
          "deploy_custom.init.args is required",
        );
      });

      it("exits 1 when init.args is not a multiline string", () => {
        expectExit(
          validYaml({
            agent_contract: {
              deploy_custom: {
                ...validDeployCustom,
                init: {
                  enabled: true,
                  method_name: "new",
                  args: "single-line",
                },
              },
            },
          }),
          "deploy_custom.init.args must be a multiline string block",
        );
      });

      it("exits 1 when deploy_custom.enabled is non-boolean", () => {
        expectExit(
          validYaml({
            agent_contract: {
              deploy_custom: { ...validDeployCustom, enabled: "yes" },
            },
          }),
          "deploy_custom.enabled must be a boolean",
        );
      });

      it("exits 1 when delete_key is non-boolean", () => {
        expectExit(
          validYaml({
            agent_contract: {
              deploy_custom: { ...validDeployCustom, delete_key: "yes" },
            },
          }),
          "deploy_custom.delete_key must be a boolean",
        );
      });

      it("exits 1 when deploy_from_source.enabled is non-boolean", () => {
        expectExit(
          validYaml({
            agent_contract: {
              deploy_custom: {
                ...validDeployCustom,
                deploy_from_source: {
                  enabled: "yes",
                  source_path: "./contract",
                },
              },
            },
          }),
          "deploy_custom.deploy_from_source.enabled must be a boolean",
        );
      });

      it("exits 1 when deploy_from_wasm.enabled is non-boolean", () => {
        expectExit(
          validYaml({
            agent_contract: {
              deploy_custom: {
                ...validDeployCustom,
                deploy_from_wasm: {
                  enabled: 1,
                  wasm_path: "./out.wasm",
                },
              },
            },
          }),
          "deploy_custom.deploy_from_wasm.enabled must be a boolean",
        );
      });

      it("exits 1 when use_global_by_hash.enabled is non-boolean", () => {
        expectExit(
          validYaml({
            agent_contract: {
              deploy_custom: {
                ...validDeployCustom,
                use_global_by_hash: {
                  enabled: "true",
                  global_hash: "abc",
                },
              },
            },
          }),
          "deploy_custom.use_global_by_hash.enabled must be a boolean",
        );
      });

      it("exits 1 when init.enabled is non-boolean", () => {
        expectExit(
          validYaml({
            agent_contract: {
              deploy_custom: {
                ...validDeployCustom,
                init: {
                  enabled: 0,
                  method_name: "new",
                  args: VALID_MULTILINE_ARGS,
                },
              },
            },
          }),
          "deploy_custom.init.enabled must be a boolean",
        );
      });
    });

    describe("mapping", () => {
      it("returns deploy_custom === undefined when enabled is false", () => {
        const config = parse(
          validYaml({
            agent_contract: { deploy_custom: { enabled: false } },
          }),
        );
        expect(config.agent_contract.deploy_custom).toBeUndefined();
      });

      it("returns deploy_custom === undefined when section is omitted", () => {
        const config = parse(
          validYaml({ agent_contract: { deploy_custom: undefined } }),
        );
        expect(config.agent_contract.deploy_custom).toBeUndefined();
      });

      it("propagates funding_amount and coerces delete_key strict-true", () => {
        const config = parse(
          validYaml({
            agent_contract: {
              deploy_custom: {
                ...validDeployCustom,
                funding_amount: 12,
                delete_key: true,
              },
            },
          }),
        );
        expect(config.agent_contract.deploy_custom.funding_amount).toBe(12);
        expect(config.agent_contract.deploy_custom.delete_key).toBe(true);
      });

      it("coerces delete_key to false when omitted", () => {
        const config = parse(
          validYaml({
            agent_contract: {
              deploy_custom: { ...validDeployCustom, delete_key: undefined },
            },
          }),
        );
        expect(config.agent_contract.deploy_custom.delete_key).toBe(false);
      });

      it("includes source_path + reproducible_build only when deploy_from_source is enabled", () => {
        const config = parse(
          validYaml({
            agent_contract: {
              deploy_custom: {
                ...validDeployCustom,
                deploy_from_source: {
                  enabled: true,
                  source_path: "./contract",
                  reproducible_build: true,
                },
                use_global_by_hash: { enabled: false },
              },
            },
          }),
        );
        expect(config.agent_contract.deploy_custom.source_path).toBe(
          "./contract",
        );
        expect(config.agent_contract.deploy_custom.reproducible_build).toBe(
          true,
        );
        expect(config.agent_contract.deploy_custom.wasm_path).toBeUndefined();
        expect(config.agent_contract.deploy_custom.global_hash).toBeUndefined();
      });

      it("coerces reproducible_build to false when not strictly true", () => {
        const config = parse(
          validYaml({
            agent_contract: {
              deploy_custom: {
                ...validDeployCustom,
                deploy_from_source: {
                  enabled: true,
                  source_path: "./contract",
                  // reproducible_build omitted
                },
                use_global_by_hash: { enabled: false },
              },
            },
          }),
        );
        expect(config.agent_contract.deploy_custom.reproducible_build).toBe(
          false,
        );
      });

      it("includes wasm_path only when deploy_from_wasm is enabled", () => {
        const config = parse(
          validYaml({
            agent_contract: {
              deploy_custom: {
                ...validDeployCustom,
                deploy_from_wasm: { enabled: true, wasm_path: "./out.wasm" },
                use_global_by_hash: { enabled: false },
              },
            },
          }),
        );
        expect(config.agent_contract.deploy_custom.wasm_path).toBe(
          "./out.wasm",
        );
        expect(config.agent_contract.deploy_custom.source_path).toBeUndefined();
        expect(config.agent_contract.deploy_custom.global_hash).toBeUndefined();
      });

      it("includes global_hash when use_global_by_hash is enabled", () => {
        const config = parse(
          validYaml({
            agent_contract: {
              deploy_custom: {
                ...validDeployCustom,
                use_global_by_hash: { enabled: true, global_hash: "h123" },
              },
            },
          }),
        );
        expect(config.agent_contract.deploy_custom.global_hash).toBe("h123");
      });

      it("returns init === undefined when init.enabled is false", () => {
        const config = parse(
          validYaml({
            agent_contract: {
              deploy_custom: {
                ...validDeployCustom,
                init: { enabled: false },
              },
            },
          }),
        );
        expect(config.agent_contract.deploy_custom.init).toBeUndefined();
      });

      it("propagates init fields and defaults tgas to 30", () => {
        const config = parse(
          validYaml({
            agent_contract: {
              deploy_custom: {
                ...validDeployCustom,
                init: {
                  enabled: true,
                  method_name: "new",
                  args: VALID_MULTILINE_ARGS,
                },
              },
            },
          }),
        );
        expect(config.agent_contract.deploy_custom.init).toEqual({
          method_name: "new",
          args: VALID_MULTILINE_ARGS,
          tgas: 30,
        });
      });

      it("respects an explicit init.tgas", () => {
        const config = parse(
          validYaml({
            agent_contract: {
              deploy_custom: {
                ...validDeployCustom,
                init: {
                  enabled: true,
                  method_name: "new",
                  args: VALID_MULTILINE_ARGS,
                  tgas: 100,
                },
              },
            },
          }),
        );
        expect(config.agent_contract.deploy_custom.init.tgas).toBe(100);
      });
    });
  });

  describe("build_docker_image", () => {
    describe("validation (TEE only)", () => {
      it("exits 1 when tag is missing", () => {
        expectExit(
          validYaml({
            build_docker_image: { ...validBuildDockerImage, tag: null },
          }),
          "build_docker_image.tag is required",
        );
      });

      it("exits 1 when cache is non-boolean", () => {
        expectExit(
          validYaml({
            build_docker_image: { ...validBuildDockerImage, cache: "true" },
          }),
          "build_docker_image.cache must be a boolean",
        );
      });

      it("exits 1 when dockerfile_path is missing", () => {
        expectExit(
          validYaml({
            build_docker_image: {
              ...validBuildDockerImage,
              dockerfile_path: null,
            },
          }),
          "build_docker_image.dockerfile_path is required",
        );
      });

      it("exits 1 when reproducible_build is non-boolean", () => {
        expectExit(
          validYaml({
            build_docker_image: {
              ...validBuildDockerImage,
              reproducible_build: "yes",
            },
          }),
          "build_docker_image.reproducible_build must be a boolean (true or false) if specified",
        );
      });

      it("exits 1 when build_docker_image.enabled is non-boolean", () => {
        expectExit(
          validYaml({
            build_docker_image: { ...validBuildDockerImage, enabled: "yes" },
          }),
          "build_docker_image.enabled must be a boolean",
        );
      });
    });

    describe("mapping", () => {
      it("propagates every field and coerces reproducible_build strict-true", () => {
        const config = parse(
          validYaml({
            build_docker_image: {
              enabled: true,
              tag: "u/agent",
              cache: false,
              dockerfile_path: "./Dockerfile.prod",
              reproducible_build: true,
            },
          }),
        );
        expect(config.build_docker_image).toEqual({
          tag: "u/agent",
          cache: false,
          dockerfile_path: "./Dockerfile.prod",
          reproducible_build: true,
        });
      });

      it("coerces reproducible_build to false when not strictly true", () => {
        const config = parse(
          validYaml({
            build_docker_image: validBuildDockerImage,
          }),
        );
        expect(config.build_docker_image.reproducible_build).toBe(false);
      });

      it("defaults cache to false when omitted", () => {
        const config = parse(
          validYaml({
            build_docker_image: {
              ...validBuildDockerImage,
              cache: undefined,
            },
          }),
        );
        expect(config.build_docker_image.cache).toBe(false);
      });

      it("returns build_docker_image === undefined when enabled is false", () => {
        const config = parse(
          validYaml({ build_docker_image: { enabled: false } }),
        );
        expect(config.build_docker_image).toBeUndefined();
      });

      it("returns build_docker_image === undefined when section is omitted", () => {
        const config = parse(validYaml({ build_docker_image: undefined }));
        expect(config.build_docker_image).toBeUndefined();
      });
    });
  });

  describe("approve_measurements", () => {
    describe("validation", () => {
      it("exits 1 when method_name is missing", () => {
        expectExit(
          validYaml({
            approve_measurements: {
              ...validApproveMeasurements,
              method_name: null,
            },
          }),
          "approve_measurements.method_name is required",
        );
      });

      it("exits 1 when args is undefined", () => {
        expectExit(
          validYaml({
            approve_measurements: {
              ...validApproveMeasurements,
              args: undefined,
            },
          }),
          "approve_measurements.args is required",
        );
      });

      it("exits 1 when args is not a multiline string", () => {
        expectExit(
          validYaml({
            approve_measurements: {
              ...validApproveMeasurements,
              args: "single-line",
            },
          }),
          "approve_measurements.args must be a multiline string block",
        );
      });

      it("exits 1 when approve_measurements.enabled is non-boolean", () => {
        expectExit(
          validYaml({
            approve_measurements: { ...validApproveMeasurements, enabled: 1 },
          }),
          "approve_measurements.enabled must be a boolean",
        );
      });
    });

    describe("mapping", () => {
      it("returns approve_measurements === undefined when enabled is false", () => {
        const config = parse(
          validYaml({ approve_measurements: { enabled: false } }),
        );
        expect(config.approve_measurements).toBeUndefined();
      });

      it("returns approve_measurements === undefined when section is omitted", () => {
        const config = parse(validYaml({ approve_measurements: undefined }));
        expect(config.approve_measurements).toBeUndefined();
      });

      it("propagates method_name and args, defaults tgas to 30", () => {
        const config = parse(
          validYaml({ approve_measurements: validApproveMeasurements }),
        );
        expect(config.approve_measurements).toEqual({
          method_name: "approve_measurements",
          args: VALID_MULTILINE_ARGS,
          tgas: 30,
        });
      });

      it("respects an explicit tgas", () => {
        const config = parse(
          validYaml({
            approve_measurements: { ...validApproveMeasurements, tgas: 75 },
          }),
        );
        expect(config.approve_measurements.tgas).toBe(75);
      });
    });
  });

  describe("approve_ppids", () => {
    describe("validation", () => {
      it("exits 1 when method_name is missing", () => {
        expectExit(
          validYaml({
            approve_ppids: { ...validApprovePpids, method_name: null },
          }),
          "approve_ppids.method_name is required",
        );
      });

      it("exits 1 when args is undefined", () => {
        expectExit(
          validYaml({
            approve_ppids: { ...validApprovePpids, args: undefined },
          }),
          "approve_ppids.args is required",
        );
      });

      it("exits 1 when args is not a multiline string", () => {
        expectExit(
          validYaml({
            approve_ppids: { ...validApprovePpids, args: "single-line" },
          }),
          "approve_ppids.args must be a multiline string block",
        );
      });

      it("exits 1 when approve_ppids.enabled is non-boolean", () => {
        expectExit(
          validYaml({
            approve_ppids: { ...validApprovePpids, enabled: "yes" },
          }),
          "approve_ppids.enabled must be a boolean",
        );
      });
    });

    describe("mapping", () => {
      it("returns approve_ppids === undefined when enabled is false", () => {
        const config = parse(validYaml({ approve_ppids: { enabled: false } }));
        expect(config.approve_ppids).toBeUndefined();
      });

      it("returns approve_ppids === undefined when section is omitted", () => {
        const config = parse(validYaml({ approve_ppids: undefined }));
        expect(config.approve_ppids).toBeUndefined();
      });

      it("propagates method_name and args, defaults tgas to 30", () => {
        const config = parse(
          validYaml({ approve_ppids: validApprovePpids }),
        );
        expect(config.approve_ppids).toEqual({
          method_name: "approve_ppids",
          args: VALID_MULTILINE_ARGS,
          tgas: 30,
        });
      });

      it("respects an explicit tgas", () => {
        const config = parse(
          validYaml({ approve_ppids: { ...validApprovePpids, tgas: 100 } }),
        );
        expect(config.approve_ppids.tgas).toBe(100);
      });
    });
  });

  describe("whitelist_agent_for_local", () => {
    describe("mapping", () => {
      it("returns whitelist_agent_for_local === undefined when omitted", () => {
        const config = parse(
          validYaml({ whitelist_agent_for_local: undefined }),
        );
        expect(config.whitelist_agent_for_local).toBeUndefined();
      });

      it("propagates method_name + args and defaults tgas to 30", () => {
        const config = parse(
          validYaml({
            whitelist_agent_for_local: {
              method_name: "whitelist_agent_for_local",
              args: VALID_MULTILINE_ARGS,
            },
          }),
        );
        expect(config.whitelist_agent_for_local).toEqual({
          method_name: "whitelist_agent_for_local",
          args: VALID_MULTILINE_ARGS,
          tgas: 30,
        });
      });

      it("respects an explicit tgas", () => {
        const config = parse(
          validYaml({
            whitelist_agent_for_local: {
              method_name: "whitelist_agent_for_local",
              args: VALID_MULTILINE_ARGS,
              tgas: 50,
            },
          }),
        );
        expect(config.whitelist_agent_for_local.tgas).toBe(50);
      });
    });
  });

  describe("deploy_to_phala", () => {
    describe("validation", () => {
      it("exits 1 when env_file_path is missing", () => {
        expectExit(
          validYaml({ deploy_to_phala: { env_file_path: null } }),
          "deploy_to_phala.env_file_path is required",
        );
      });

      it("exits 1 when app_name is missing", () => {
        expectExit(
          validYaml({ deploy_to_phala: { app_name: null } }),
          "deploy_to_phala.app_name is required",
        );
      });

      it("exits 1 when dstack_version is missing on TEE", () => {
        expectExit(
          validYaml({ deploy_to_phala: { dstack_version: null } }),
          "deploy_to_phala.dstack_version is required",
        );
      });

      it("exits 1 when dstack_version is unsupported on TEE", () => {
        expectExit(
          validYaml({ deploy_to_phala: { dstack_version: "9.9.9" } }),
          'deploy_to_phala.dstack_version "9.9.9" is not supported',
        );
      });

      it("exits 1 when instance_type is missing on TEE", () => {
        expectExit(
          validYaml({ deploy_to_phala: { instance_type: null } }),
          "deploy_to_phala.instance_type is required",
        );
      });

      it("exits 1 when instance_type is unsupported for the dstack_version on TEE", () => {
        expectExit(
          validYaml({ deploy_to_phala: { instance_type: "tdx.bogus" } }),
          'deploy_to_phala.instance_type "tdx.bogus" is not supported',
        );
      });

      it("exits 1 when public_logs is missing", () => {
        expectExit(
          validYaml({ deploy_to_phala: { public_logs: null } }),
          "deploy_to_phala.public_logs is required and must be a boolean",
        );
      });

      it("exits 1 when public_sysinfo is missing", () => {
        expectExit(
          validYaml({ deploy_to_phala: { public_sysinfo: null } }),
          "deploy_to_phala.public_sysinfo is required and must be a boolean",
        );
      });

      it("exits 1 when public_logs is a non-boolean string", () => {
        expectExit(
          validYaml({ deploy_to_phala: { public_logs: "true" } }),
          "deploy_to_phala.public_logs is required and must be a boolean",
        );
      });

      it("exits 1 when public_sysinfo is a non-boolean number", () => {
        expectExit(
          validYaml({ deploy_to_phala: { public_sysinfo: 1 } }),
          "deploy_to_phala.public_sysinfo is required and must be a boolean",
        );
      });

      it("still requires public_logs / public_sysinfo when environment is local", () => {
        expectExit(
          validYaml({
            environment: "local",
            deploy_to_phala: { public_logs: null },
          }),
          "deploy_to_phala.public_logs is required and must be a boolean",
        );
      });

      it("exits 1 when deploy_to_phala.enabled is non-boolean", () => {
        expectExit(
          validYaml({ deploy_to_phala: { enabled: "yes" } }),
          "deploy_to_phala.enabled must be a boolean",
        );
      });
    });

    describe("mapping", () => {
      it("propagates every field into config.deploy_to_phala", () => {
        const config = parse(
          validYaml({
            deploy_to_phala: {
              enabled: true,
              app_name: "my-other-agent",
              env_file_path: "./envs/prod.env",
              dstack_version: "0.5.7",
              instance_type: "tdx.medium",
              public_logs: false,
              public_sysinfo: true,
            },
          }),
        );
        expect(config.deploy_to_phala).toEqual({
          enabled: true,
          app_name: "my-other-agent",
          env_file_path: "./envs/prod.env",
          dstack_version: "0.5.7",
          instance_type: "tdx.medium",
          public_logs: false,
          public_sysinfo: true,
        });
      });

      // No <MEASUREMENTS> placeholder → measurement fields aren't required.
      it("skips measurement-field validation when args omit <MEASUREMENTS>", () => {
        const config = parse(
          validYaml({
            approve_measurements: {
              enabled: true,
              method_name: "approve_measurements",
              args: '{ "list": [] }\n',
            },
            deploy_to_phala: undefined,
          }),
        );
        expect(config.deploy_to_phala).toBeUndefined();
      });

      // approve_measurements in TEE still needs valid dstack_version,
      // instance_type, and public_* even when deploy_to_phala.enabled is
      // false — those fields feed the measurement calculation.
      it("validates measurement fields when phala is off but approve_measurements is on in TEE", () => {
        expectExit(
          validYaml({
            approve_measurements: {
              enabled: true,
              method_name: "approve_measurements",
              args: '{\n  "measurements": <MEASUREMENTS>\n}\n',
            },
            deploy_to_phala: {
              enabled: false,
              dstack_version: "9.9.9",
            },
          }),
          'deploy_to_phala.dstack_version "9.9.9" is not supported',
        );
      });

      // When the block is present with enabled=false, the parser still
      // emits the measurement-related fields (dstack_version, instance_type,
      // public_*) so `approve_measurements` can read them; only `enabled`
      // is flipped so the phala deploy workflow itself is skipped.
      it("returns enabled=false when enabled is false but keeps the fields", () => {
        const config = parse(
          validYaml({
            deploy_to_phala: {
              enabled: false,
              app_name: "x",
              env_file_path: "./.env",
              dstack_version: "0.5.7",
              instance_type: "tdx.medium",
              public_logs: false,
              public_sysinfo: true,
            },
          }),
        );
        expect(config.deploy_to_phala).toEqual({
          enabled: false,
          app_name: "x",
          env_file_path: "./.env",
          dstack_version: "0.5.7",
          instance_type: "tdx.medium",
          public_logs: false,
          public_sysinfo: true,
        });
      });

      it("returns deploy_to_phala === undefined when the section is omitted", () => {
        const config = parse(validYaml({ deploy_to_phala: undefined }));
        expect(config.deploy_to_phala).toBeUndefined();
      });

      it("local environment skips dstack_version / instance_type validation but still maps them", () => {
        const config = parse(
          validYaml({
            environment: "local",
            docker_compose_path: undefined,
            deploy_to_phala: {
              dstack_version: undefined,
              instance_type: undefined,
            },
          }),
        );
        expect(config.deploy_to_phala.dstack_version).toBeUndefined();
        expect(config.deploy_to_phala.instance_type).toBeUndefined();
        expect(config.deploy_to_phala.public_logs).toBe(true);
        expect(config.deploy_to_phala.public_sysinfo).toBe(true);
      });

      it("preserves both flags as false (ensuring boolean false isn't coerced)", () => {
        const config = parse(
          validYaml({
            deploy_to_phala: { public_logs: false, public_sysinfo: false },
          }),
        );
        expect(config.deploy_to_phala.public_logs).toBe(false);
        expect(config.deploy_to_phala.public_sysinfo).toBe(false);
      });
    });
  });
});
