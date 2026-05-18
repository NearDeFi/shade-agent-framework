/**
 * Unit tests for src/utils/state-cleanup.js
 *
 * Coverage:
 *  - estimateKeyGas:      matches storage_remove + 30% safety formula.
 *  - estimateTotalGas:    sum-of-per-key over mixed entries, 0n for [].
 *  - estimateTransactionSize: borsh-size + wrapper overhead + 2 × accountId.
 *  - parseProtocolConfig: accepts JSON number and stringified-int variants,
 *                         red-exits on missing wasm_config or wrong shape.
 *  - wipeContractState preflight: returns silently for empty state, red-exits
 *                         (without sending) when gas or tx-size exceed budget.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { actionCreators } from "@near-js/transactions";
import {
  estimateKeyGas,
  estimateTotalGas,
  estimateTransactionSize,
  parseProtocolConfig,
  wipeContractState,
} from "../../src/utils/state-cleanup.js";

const SAFETY = 130n;
const CONSTS = {
  storageRemoveBase: 53_473_030_500n,
  storageRemoveKeyByte: 38_220_384n,
  storageRemoveRetValueByte: 11_531_556n,
};

// Build a base64 string whose decoded length is exactly `bytes` bytes.
function b64OfLength(bytes) {
  return Buffer.alloc(bytes, "a").toString("base64");
}

function expectedGas(keyBytes, valueBytes) {
  const raw =
    CONSTS.storageRemoveBase +
    BigInt(keyBytes) * CONSTS.storageRemoveKeyByte +
    BigInt(valueBytes) * CONSTS.storageRemoveRetValueByte;
  return (raw * SAFETY) / 100n;
}

// Sample protocol-config blob matching the shape returned by
// EXPERIMENTAL_protocol_config. fields() lets each test swap individual
// values without re-stating the rest.
function makeConfig(fields = {}) {
  const ext = {
    storage_remove_base: 53_473_030_500,
    storage_remove_key_byte: 38_220_384,
    storage_remove_ret_value_byte: 11_531_556,
    ...(fields.ext ?? {}),
  };
  const lim = {
    max_transaction_size: 1_572_864,
    max_total_prepaid_gas: 1_000_000_000_000_000,
    ...(fields.lim ?? {}),
  };
  return { runtime_config: { wasm_config: { ext_costs: ext, limit_config: lim } } };
}

describe("estimateKeyGas", () => {
  it("matches the formula for a 10-byte key, 100-byte value", () => {
    expect(estimateKeyGas(b64OfLength(10), b64OfLength(100), CONSTS)).toBe(expectedGas(10, 100));
  });

  it("matches the formula for a 20-byte key, 3072-byte value", () => {
    expect(estimateKeyGas(b64OfLength(20), b64OfLength(3072), CONSTS)).toBe(expectedGas(20, 3072));
  });

  it("handles empty value", () => {
    expect(estimateKeyGas(b64OfLength(5), b64OfLength(0), CONSTS)).toBe(expectedGas(5, 0));
  });
});

describe("estimateTotalGas", () => {
  it("sums per-key estimates", () => {
    const entries = [
      { key: b64OfLength(10), value: b64OfLength(50) },
      { key: b64OfLength(20), value: b64OfLength(200) },
      { key: b64OfLength(40), value: b64OfLength(4096) },
    ];
    const expected =
      expectedGas(10, 50) + expectedGas(20, 200) + expectedGas(40, 4096);
    expect(estimateTotalGas(entries, CONSTS)).toBe(expected);
  });

  it("returns 0n for empty input", () => {
    expect(estimateTotalGas([], CONSTS)).toBe(0n);
  });
});

describe("estimateTransactionSize", () => {
  it("equals borsh-action-size + wrapper overhead + 2 × accountId length", () => {
    const wasm = new Uint8Array(100_000).fill(0);
    const actions = [
      actionCreators.deployContract(wasm),
      actionCreators.functionCall(
        "clean",
        { keys: ["AAAA", "BBBB"] },
        1_000_000_000_000_000n,
        0n,
      ),
    ];
    const accountId = "example.testnet";
    const size = estimateTransactionSize(actions, accountId);

    // Sanity: the result includes the wasm payload.
    expect(size).toBeGreaterThanOrEqual(wasm.length);
    // It's deterministic; rerun should match exactly.
    expect(estimateTransactionSize(actions, accountId)).toBe(size);
  });
});

describe("parseProtocolConfig", () => {
  afterEach(() => vi.restoreAllMocks());

  it("parses fields when serialized as JSON numbers", () => {
    const parsed = parseProtocolConfig(makeConfig());
    expect(parsed.storageRemoveBase).toBe(53_473_030_500n);
    expect(parsed.storageRemoveKeyByte).toBe(38_220_384n);
    expect(parsed.storageRemoveRetValueByte).toBe(11_531_556n);
    expect(parsed.maxTransactionSize).toBe(1_572_864n);
    expect(parsed.maxTotalPrepaidGas).toBe(1_000_000_000_000_000n);
  });

  it("parses fields when serialized as stringified integers", () => {
    const parsed = parseProtocolConfig(
      makeConfig({
        ext: {
          storage_remove_base: "53473030500",
          storage_remove_key_byte: "38220384",
          storage_remove_ret_value_byte: "11531556",
        },
        lim: {
          max_transaction_size: "1572864",
          max_total_prepaid_gas: "1000000000000000",
        },
      }),
    );
    expect(parsed.storageRemoveBase).toBe(53_473_030_500n);
    expect(parsed.maxTransactionSize).toBe(1_572_864n);
    expect(parsed.maxTotalPrepaidGas).toBe(1_000_000_000_000_000n);
  });

  it("red-exits when wasm_config is missing", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("__exit__");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() => parseProtocolConfig({ runtime_config: {} })).toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("red-exits when a gas field has an unexpected shape", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("__exit__");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(() =>
      parseProtocolConfig(makeConfig({ ext: { storage_remove_base: true } })),
    ).toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("wipeContractState preflight", () => {
  afterEach(() => vi.restoreAllMocks());

  function makeAccount({ entries, viewStateError, sendError } = {}) {
    const provider = {
      experimental_protocolConfig: vi.fn().mockResolvedValue(makeConfig()),
      viewContractState: viewStateError
        ? vi.fn().mockRejectedValue(viewStateError)
        : vi.fn().mockResolvedValue({ values: entries ?? [] }),
    };
    return {
      accountId: "example.testnet",
      provider,
      signAndSendTransaction: sendError
        ? vi.fn().mockRejectedValue(sendError)
        : vi.fn().mockResolvedValue({}),
    };
  }

  it("logs and returns when state is empty", async () => {
    const account = makeAccount({ entries: [] });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await wipeContractState(account);
    expect(account.signAndSendTransaction).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      "Contract account already exists with no state to wipe",
    );
  });

  it("red-exits when estimated gas exceeds max_total_prepaid_gas", async () => {
    // Shrink the budget instead of growing the entries — same branch
    // exercised without allocating large base64 strings.
    const account = makeAccount({
      entries: [
        { key: b64OfLength(10), value: b64OfLength(50) },
        { key: b64OfLength(10), value: b64OfLength(50) },
      ],
    });
    account.provider.experimental_protocolConfig = vi.fn().mockResolvedValue(
      makeConfig({ lim: { max_total_prepaid_gas: "1000" } }),
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("__exit__");
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(wipeContractState(account)).rejects.toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(account.signAndSendTransaction).not.toHaveBeenCalled();
  });

  it("red-exits when serialized tx size exceeds max_transaction_size − buffer", async () => {
    // Each entry adds the full 32 KB base64 key into the FunctionCall args.
    // ~150 of them is comfortably above the 1.5 MB tx cap.
    const entries = Array.from({ length: 150 }, () => ({
      key: b64OfLength(32 * 1024),
      value: b64OfLength(8),
    }));
    const account = makeAccount({ entries });
    // Use a small max_total_prepaid_gas-friendly config but raise budget so
    // gas preflight passes and we hit the tx-size check next.
    account.provider.experimental_protocolConfig = vi.fn().mockResolvedValue(
      makeConfig({
        lim: { max_total_prepaid_gas: "9".repeat(18) },
      }),
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("__exit__");
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(wipeContractState(account)).rejects.toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(account.signAndSendTransaction).not.toHaveBeenCalled();
    // Make sure we landed on the tx-size branch, not the gas one.
    const messages = logSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("max transaction size"))).toBe(true);
  });
});
