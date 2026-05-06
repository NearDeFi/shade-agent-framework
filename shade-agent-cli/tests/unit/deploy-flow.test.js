/**
 * Unit tests for src/commands/deploy/index.js — config-driven orchestration.
 *
 * Given a synthetic deployment.yaml, these tests verify which side-effect
 * helpers (dockerImage, createAccount, deploy*From*, initContract,
 * approveMeasurements, approvePpids, deleteContractKey, deployPhalaWorkflow,
 * confirmDestructiveRedeployIfAccountExists) are invoked and which are not.
 *
 * Tested branches:
 *  - TEE + build_docker_image     → dockerImage called
 *  - local + build_docker_image   → dockerImage NOT called
 *  - deploy_custom absent         → all deploy_custom helpers skipped
 *  - source_path                  → deployCustomContractFromSource called
 *  - wasm_path                    → deployCustomContractFromWasm called
 *  - global_hash                  → deployCustomContractFromGlobalHash called
 *  - init                         → initContract called
 *  - delete_key === true          → deleteContractKey called
 *  - delete_key === false         → deleteContractKey NOT called
 *  - approve_measurements         → approveMeasurements called
 *  - approve_ppids                → approvePpids called
 *  - deploy_to_phala + TEE        → deployPhalaWorkflow called
 *  - deploy_to_phala + local      → deployPhalaWorkflow NOT called
 *
 * Notes:
 *  - All side-effect helpers are mocked. confirmDestructiveRedeployIfAccountExists
 *    is mocked to a no-op so tests don't hit a prompt.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/commands/deploy/docker.js", () => ({
  dockerImage: vi.fn(),
}));
vi.mock("../../src/commands/deploy/near.js", () => ({
  createAccount: vi.fn(),
  deployCustomContractFromSource: vi.fn(),
  deployCustomContractFromWasm: vi.fn(),
  deployCustomContractFromGlobalHash: vi.fn(),
  initContract: vi.fn(),
  approveMeasurements: vi.fn(),
  approvePpids: vi.fn(),
  deleteContractKey: vi.fn(),
}));
vi.mock("../../src/commands/deploy/phala.js", () => ({
  deployPhalaWorkflow: vi.fn(),
}));
vi.mock("../../src/utils/destructive-redeploy.js", () => ({
  confirmDestructiveRedeployIfAccountExists: vi.fn(),
}));
vi.mock("../../src/utils/config.js", () => ({
  getConfig: vi.fn(),
}));
vi.mock("../../src/utils/error-handler.js", () => ({
  createCommandErrorHandler: () => ({
    writeOut: () => {},
    writeErr: () => {},
    outputError: () => {},
  }),
}));

const { deployCommand } = await import("../../src/commands/deploy/index.js");
const { dockerImage } = await import("../../src/commands/deploy/docker.js");
const {
  createAccount,
  deployCustomContractFromSource,
  deployCustomContractFromWasm,
  deployCustomContractFromGlobalHash,
  initContract,
  approveMeasurements,
  approvePpids,
  deleteContractKey,
} = await import("../../src/commands/deploy/near.js");
const { deployPhalaWorkflow } = await import(
  "../../src/commands/deploy/phala.js"
);
const { getConfig } = await import("../../src/utils/config.js");

const baseConfig = (overrides = {}) => ({
  deployment: {
    environment: "TEE",
    network: "testnet",
    docker_compose_path: "./docker-compose.yaml",
    agent_contract: {},
    ...overrides,
  },
});

async function runDeploy() {
  const cmd = deployCommand();
  await cmd.parseAsync(["node", "shade"]);
}

describe("deploy command orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  // Hash-of-image step only runs in TEE; local deploys skip it.
  it("calls dockerImage when environment is TEE and build_docker_image is set", async () => {
    vi.mocked(getConfig).mockResolvedValue(
      baseConfig({ build_docker_image: { tag: "x" } }),
    );
    await runDeploy();
    expect(dockerImage).toHaveBeenCalledOnce();
  });

  // Local mode never builds a docker image.
  it("does NOT call dockerImage when environment is local", async () => {
    vi.mocked(getConfig).mockResolvedValue(
      baseConfig({ environment: "local", build_docker_image: { tag: "x" } }),
    );
    await runDeploy();
    expect(dockerImage).not.toHaveBeenCalled();
  });

  // No deploy_custom block → no account create, no contract deploy, no init,
  // no key delete.
  it("skips ALL deploy_custom helpers when deploy_custom is absent", async () => {
    vi.mocked(getConfig).mockResolvedValue(baseConfig({}));
    await runDeploy();
    expect(createAccount).not.toHaveBeenCalled();
    expect(deployCustomContractFromSource).not.toHaveBeenCalled();
    expect(deployCustomContractFromWasm).not.toHaveBeenCalled();
    expect(deployCustomContractFromGlobalHash).not.toHaveBeenCalled();
    expect(initContract).not.toHaveBeenCalled();
    expect(deleteContractKey).not.toHaveBeenCalled();
  });

  // source_path picks the from-source builder, never the wasm or global-hash ones.
  it("dispatches to deployCustomContractFromSource when source_path is set", async () => {
    vi.mocked(getConfig).mockResolvedValue(
      baseConfig({
        agent_contract: {
          contract_id: "x.testnet",
          deploy_custom: { source_path: "./contract" },
        },
      }),
    );
    await runDeploy();
    expect(deployCustomContractFromSource).toHaveBeenCalledOnce();
    expect(deployCustomContractFromWasm).not.toHaveBeenCalled();
    expect(deployCustomContractFromGlobalHash).not.toHaveBeenCalled();
  });

  // wasm_path picks the from-wasm builder.
  it("dispatches to deployCustomContractFromWasm when wasm_path is set", async () => {
    vi.mocked(getConfig).mockResolvedValue(
      baseConfig({
        agent_contract: {
          contract_id: "x.testnet",
          deploy_custom: { wasm_path: "./out.wasm" },
        },
      }),
    );
    await runDeploy();
    expect(deployCustomContractFromWasm).toHaveBeenCalledOnce();
    expect(deployCustomContractFromSource).not.toHaveBeenCalled();
    expect(deployCustomContractFromGlobalHash).not.toHaveBeenCalled();
  });

  // global_hash dispatches to the global-by-hash deployer.
  it("dispatches to deployCustomContractFromGlobalHash when global_hash is set", async () => {
    vi.mocked(getConfig).mockResolvedValue(
      baseConfig({
        agent_contract: {
          contract_id: "x.testnet",
          deploy_custom: { global_hash: "abc" },
        },
      }),
    );
    await runDeploy();
    expect(deployCustomContractFromGlobalHash).toHaveBeenCalledOnce();
    expect(deployCustomContractFromSource).not.toHaveBeenCalled();
    expect(deployCustomContractFromWasm).not.toHaveBeenCalled();
  });

  // init present → initContract called (post-deploy).
  it("calls initContract when deploy_custom.init is set", async () => {
    vi.mocked(getConfig).mockResolvedValue(
      baseConfig({
        agent_contract: {
          contract_id: "x.testnet",
          deploy_custom: { init: { method_name: "new" } },
        },
      }),
    );
    await runDeploy();
    expect(initContract).toHaveBeenCalledOnce();
  });

  // delete_key true → contract key removed after deploy.
  it("calls deleteContractKey when deploy_custom.delete_key is true", async () => {
    vi.mocked(getConfig).mockResolvedValue(
      baseConfig({
        agent_contract: {
          contract_id: "x.testnet",
          deploy_custom: { delete_key: true },
        },
      }),
    );
    await runDeploy();
    expect(deleteContractKey).toHaveBeenCalledOnce();
  });

  // delete_key false → key is preserved (regression test for the explicit
  // request: a falsy delete_key must not call deleteContractKey).
  it("does NOT call deleteContractKey when deploy_custom.delete_key is false", async () => {
    vi.mocked(getConfig).mockResolvedValue(
      baseConfig({
        agent_contract: {
          contract_id: "x.testnet",
          deploy_custom: { delete_key: false },
        },
      }),
    );
    await runDeploy();
    expect(deleteContractKey).not.toHaveBeenCalled();
  });

  // approve_measurements present → approveMeasurements called.
  it("calls approveMeasurements when approve_measurements is set", async () => {
    vi.mocked(getConfig).mockResolvedValue(
      baseConfig({
        approve_measurements: { method_name: "approve_measurements" },
      }),
    );
    await runDeploy();
    expect(approveMeasurements).toHaveBeenCalledOnce();
  });

  // approve_ppids present → approvePpids called.
  it("calls approvePpids when approve_ppids is set", async () => {
    vi.mocked(getConfig).mockResolvedValue(
      baseConfig({ approve_ppids: { method_name: "approve_ppids" } }),
    );
    await runDeploy();
    expect(approvePpids).toHaveBeenCalledOnce();
  });

  // Phala deploy is gated on TEE env.
  it("calls deployPhalaWorkflow when deploy_to_phala is set and environment is TEE", async () => {
    vi.mocked(getConfig).mockResolvedValue(
      baseConfig({
        deploy_to_phala: {
          app_name: "x",
          dstack_version: "0.5.8",
          instance_type: "tdx.small",
          public_logs: true,
          public_sysinfo: true,
        },
      }),
    );
    await runDeploy();
    expect(deployPhalaWorkflow).toHaveBeenCalledOnce();
  });

  // Local mode + deploy_to_phala set → never reaches Phala.
  it("does NOT call deployPhalaWorkflow when environment is local", async () => {
    vi.mocked(getConfig).mockResolvedValue(
      baseConfig({
        environment: "local",
        deploy_to_phala: {
          app_name: "x",
          dstack_version: "0.5.8",
          instance_type: "tdx.small",
          public_logs: true,
          public_sysinfo: true,
        },
      }),
    );
    await runDeploy();
    expect(deployPhalaWorkflow).not.toHaveBeenCalled();
  });
});
