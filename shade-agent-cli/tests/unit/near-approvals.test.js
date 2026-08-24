/**
 * Unit tests for the placeholder guards in src/commands/deploy/near.js.
 *
 * `docs/reference/cli.md` promises that a literal PPID or a literal measurements
 * object written into `args` works without the placeholder. For the dstack
 * backend that promise is only true if the CLI skips the lookups, because both
 * of them are live SSH calls to the server's KMS that hard-exit when it is
 * unreachable — so a literal-args config would otherwise still require the
 * server to be up.
 *
 * Coverage:
 *  - <MEASUREMENTS> absent  → getMeasurements and getKeyProviderEventDigest not called
 *  - <MEASUREMENTS> present → both called, value substituted
 *  - <PPIDS> absent         → getPpids not called
 *  - <PPIDS> present        → called, value substituted
 *  - literal args are still sent to the contract verbatim
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getMeasurements = vi.fn(() => ({ rtmrs: {}, mock: true }));
const getPpids = vi.fn(async () => ["deadbeef"]);
const getKeyProviderEventDigest = vi.fn(() => "ab".repeat(48));
const callFunctionRaw = vi.fn(async () => ({}));

vi.mock("../../src/utils/measurements.js", () => ({
  getMeasurements: (...a) => getMeasurements(...a),
}));
vi.mock("../../src/utils/ppids.js", () => ({
  getPpids: (...a) => getPpids(...a),
}));
vi.mock("../../src/utils/dstack-kms.js", () => ({
  getKeyProviderEventDigest: (...a) => getKeyProviderEventDigest(...a),
}));
vi.mock("../../src/utils/transaction-outcome.js", () => ({
  checkTransactionOutcome: () => true,
}));
vi.mock("../../src/utils/state-cleanup.js", () => ({ wipeContractState: vi.fn() }));
vi.mock("../../src/utils/docker-utils.js", () => ({
  dockerExec: vi.fn(),
  runWithSudoOnLinux: vi.fn(),
}));

let deployment;
vi.mock("../../src/utils/config.js", () => ({
  getConfig: async () => ({
    masterAccount: { accountId: "owner.testnet", callFunctionRaw },
    contractAccount: {},
    deployment,
  }),
}));

const { approveMeasurements, approvePpids } = await import(
  "../../src/commands/deploy/near.js"
);

// A dstack-backend deployment: every lookup here would touch the server.
const dstackDeployment = (overrides = {}) => ({
  environment: "TEE",
  docker_compose_path: "./docker-compose.yaml",
  tee_config: {
    backend: "server",
    dstack_version: "0.5.8",
    instance_type: "tdx.small",
    public_logs: true,
    public_sysinfo: true,
    server: { ssh_host: "tdx" },
  },
  agent_contract: { contract_id: "agent.testnet" },
  ...overrides,
});

const sentArgs = () => callFunctionRaw.mock.calls.at(-1)[0].args;

describe("approveMeasurements placeholder guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMeasurements.mockReturnValue({ rtmrs: {}, mock: true });
    getKeyProviderEventDigest.mockReturnValue("ab".repeat(48));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  // The point of the fix: no SSH to the KMS for a config that already has its
  // measurements written out.
  it("computes nothing when args carry literal measurements", async () => {
    deployment = dstackDeployment({
      approve_measurements: {
        method_name: "approve_measurements",
        args: '{\n  "measurements": {"rtmrs": {"mrtd": "aa"}}\n}\n',
        tgas: 30,
      },
    });
    await approveMeasurements();
    expect(getKeyProviderEventDigest).not.toHaveBeenCalled();
    expect(getMeasurements).not.toHaveBeenCalled();
    expect(sentArgs()).toEqual({ measurements: { rtmrs: { mrtd: "aa" } } });
  });

  it("computes them when the placeholder is present", async () => {
    deployment = dstackDeployment({
      approve_measurements: {
        method_name: "approve_measurements",
        args: '{\n  "measurements": <MEASUREMENTS>\n}\n',
        tgas: 30,
      },
    });
    await approveMeasurements();
    expect(getKeyProviderEventDigest).toHaveBeenCalledWith("tdx");
    expect(getMeasurements).toHaveBeenCalled();
    expect(sentArgs()).toEqual({ measurements: { rtmrs: {}, mock: true } });
  });
});

describe("approvePpids placeholder guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPpids.mockResolvedValue(["deadbeef"]);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("looks nothing up when args carry a literal PPID", async () => {
    deployment = dstackDeployment({
      approve_ppids: {
        method_name: "approve_ppids",
        args: '{\n  "ppids": ["98d4560c0c8b3be964edbb9310366155"]\n}\n',
        tgas: 30,
      },
    });
    await approvePpids();
    expect(getPpids).not.toHaveBeenCalled();
    expect(sentArgs()).toEqual({ ppids: ["98d4560c0c8b3be964edbb9310366155"] });
  });

  it("looks them up when the placeholder is present", async () => {
    deployment = dstackDeployment({
      approve_ppids: {
        method_name: "approve_ppids",
        args: '{\n  "ppids": <PPIDS>\n}\n',
        tgas: 30,
      },
    });
    await approvePpids();
    expect(getPpids).toHaveBeenCalledWith(deployment);
    expect(sentArgs()).toEqual({ ppids: ["deadbeef"] });
  });
});
