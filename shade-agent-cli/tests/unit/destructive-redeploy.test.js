/**
 * Unit tests for src/utils/destructive-redeploy.js — confirmation branches.
 *
 * Coverage:
 *  - deploy_custom absent → returns undefined; prompt is not shown.
 *  - account does NOT exist (AccountDoesNotExist) → returns null.
 *  - account exists + user types "yes" → returns the on-chain state object
 *    so prepareContractAccount can reuse it (no second RPC probe).
 *  - account exists + "yes " (trailing whitespace) → accepted via trim().
 *  - account exists + "y", "Yes", "" (Enter) → process.exit(1).
 *  - account exists + input throws (Ctrl+C / EOF) → process.exit(1).
 *
 * Notes:
 *  - getConfig and @inquirer/input are mocked.
 *  - process.exit is spied so abort assertions work without terminating the
 *    test runner.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockInput } = vi.hoisted(() => ({
  mockInput: vi.fn(),
}));

vi.mock("@inquirer/input", () => ({
  default: mockInput,
}));

vi.mock("../../src/utils/config.js", () => ({
  getConfig: vi.fn(),
}));

const { getConfig } = await import("../../src/utils/config.js");
const { confirmDestructiveRedeployIfAccountExists } = await import(
  "../../src/utils/destructive-redeploy.js"
);

const FAKE_STATE = { balance: { total: "1000000000000000000000000" } };

const accountExists = (id) => ({
  deployment: {
    agent_contract: { contract_id: id, deploy_custom: { source_path: "./x" } },
  },
  contractAccount: { getState: vi.fn().mockResolvedValue(FAKE_STATE) },
});

const accountMissing = (id) => ({
  deployment: {
    agent_contract: { contract_id: id, deploy_custom: { source_path: "./x" } },
  },
  contractAccount: {
    getState: vi.fn().mockRejectedValue(
      Object.assign(new Error("not found"), { type: "AccountDoesNotExist" }),
    ),
  },
});

describe("confirmDestructiveRedeployIfAccountExists", () => {
  let exitSpy;
  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  // Without deploy_custom there's nothing destructive to confirm — return
  // undefined immediately, never prompt.
  it("returns undefined when deploy_custom is absent", async () => {
    vi.mocked(getConfig).mockResolvedValue({
      deployment: { agent_contract: { contract_id: "x.testnet" } },
      contractAccount: { getState: vi.fn() },
    });
    const result = await confirmDestructiveRedeployIfAccountExists();
    expect(result).toBeUndefined();
    expect(mockInput).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // No account on-chain ⇒ nothing to delete ⇒ no prompt; returns null so
  // prepareContractAccount knows there's nothing to delete and skips its RPC probe.
  it("returns null when the contract account doesn't exist", async () => {
    vi.mocked(getConfig).mockResolvedValue(accountMissing("x.testnet"));
    const result = await confirmDestructiveRedeployIfAccountExists();
    expect(result).toBeNull();
    expect(mockInput).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // Confirmation flow: typing exactly "yes" continues and returns the state
  // object so callers can reuse it without re-probing the RPC.
  it("returns the prefetched account state when the user types 'yes'", async () => {
    vi.mocked(getConfig).mockResolvedValue(accountExists("x.testnet"));
    mockInput.mockResolvedValue("yes");
    const result = await confirmDestructiveRedeployIfAccountExists();
    expect(result).toBe(FAKE_STATE);
    expect(mockInput).toHaveBeenCalledOnce();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // Whitespace around the answer is OK (trim()).
  it("accepts 'yes ' with trailing whitespace", async () => {
    vi.mocked(getConfig).mockResolvedValue(accountExists("x.testnet"));
    mockInput.mockResolvedValue("yes ");
    await confirmDestructiveRedeployIfAccountExists();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // 'y' is not 'yes' — abort.
  it("exits 1 when the user types 'y'", async () => {
    vi.mocked(getConfig).mockResolvedValue(accountExists("x.testnet"));
    mockInput.mockResolvedValue("y");
    await expect(confirmDestructiveRedeployIfAccountExists()).rejects.toThrow(
      "exit:1",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // Case-sensitivity: 'Yes' is rejected.
  it("exits 1 when the user types 'Yes' (case-sensitive)", async () => {
    vi.mocked(getConfig).mockResolvedValue(accountExists("x.testnet"));
    mockInput.mockResolvedValue("Yes");
    await expect(confirmDestructiveRedeployIfAccountExists()).rejects.toThrow(
      "exit:1",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // Empty input (bare Enter) is rejected.
  it("exits 1 when the user just presses Enter", async () => {
    vi.mocked(getConfig).mockResolvedValue(accountExists("x.testnet"));
    mockInput.mockResolvedValue("");
    await expect(confirmDestructiveRedeployIfAccountExists()).rejects.toThrow(
      "exit:1",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // Ctrl+C / EOF surface as a thrown ExitPromptError — same abort path.
  it("exits 1 when the input prompt throws (Ctrl+C / EOF)", async () => {
    vi.mocked(getConfig).mockResolvedValue(accountExists("x.testnet"));
    mockInput.mockRejectedValue(new Error("ExitPromptError"));
    await expect(confirmDestructiveRedeployIfAccountExists()).rejects.toThrow(
      "exit:1",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
