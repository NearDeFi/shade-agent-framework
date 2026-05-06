/**
 * Unit tests for src/utils/config.js — parseDeploymentConfig validation.
 *
 * Coverage focused on the new mandatory deploy_to_phala booleans:
 *  - public_logs / public_sysinfo must be present and boolean when
 *    deploy_to_phala.enabled !== false.
 *  - Missing or non-boolean values exit 1 via chalk.red + process.exit.
 *  - When deploy_to_phala.enabled === false, validation is skipped (matches
 *    the existing pattern for env_file_path / app_name).
 *  - When values are valid, the parsed config carries them through to the
 *    returned deploy_to_phala object.
 *
 * Notes:
 *  - Uses real tmpdir files instead of fs mocks because parseDeploymentConfig
 *    holds named imports of readFileSync / existsSync that vi.spyOn cannot
 *    intercept.
 *  - process.exit is spied so abort paths are observable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const { parseDeploymentConfig } = await import("../../src/utils/config.js");

const baseYaml = (deployToPhalaBlock) => `
environment: local
network: testnet
docker_compose_path: ./docker-compose.yaml
agent_contract:
  contract_id: example-contract-123.testnet
${deployToPhalaBlock}
`;

let tmpDir;
let yamlPath;

function writeYaml(content) {
  fs.writeFileSync(yamlPath, content, "utf8");
}

describe("parseDeploymentConfig — deploy_to_phala public_logs / public_sysinfo", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shade-config-test-"));
    yamlPath = path.join(tmpDir, "deployment.yaml");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("accepts both flags as booleans and propagates them", () => {
    writeYaml(
      baseYaml(`deploy_to_phala:
  enabled: true
  app_name: my-agent
  env_file_path: ./.env
  public_logs: true
  public_sysinfo: false
`),
    );
    const config = parseDeploymentConfig(yamlPath);
    expect(config.deploy_to_phala.public_logs).toBe(true);
    expect(config.deploy_to_phala.public_sysinfo).toBe(false);
  });

  it("exits 1 when public_logs is missing", () => {
    writeYaml(
      baseYaml(`deploy_to_phala:
  enabled: true
  app_name: my-agent
  env_file_path: ./.env
  public_sysinfo: true
`),
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    expect(() => parseDeploymentConfig(yamlPath)).toThrow("exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits 1 when public_sysinfo is missing", () => {
    writeYaml(
      baseYaml(`deploy_to_phala:
  enabled: true
  app_name: my-agent
  env_file_path: ./.env
  public_logs: true
`),
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    expect(() => parseDeploymentConfig(yamlPath)).toThrow("exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits 1 when public_logs is a non-boolean (string)", () => {
    writeYaml(
      baseYaml(`deploy_to_phala:
  enabled: true
  app_name: my-agent
  env_file_path: ./.env
  public_logs: "true"
  public_sysinfo: true
`),
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    expect(() => parseDeploymentConfig(yamlPath)).toThrow("exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("skips validation when deploy_to_phala.enabled is false", () => {
    writeYaml(
      baseYaml(`deploy_to_phala:
  enabled: false
  app_name: my-agent
  env_file_path: ./.env
`),
    );
    const config = parseDeploymentConfig(yamlPath);
    expect(config.deploy_to_phala).toBeUndefined();
  });
});
