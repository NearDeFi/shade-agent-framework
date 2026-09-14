import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchCollateralWithFallback,
  DEFAULT_PCCS_ENDPOINTS,
} from "../../src/utils/collateral";
import {
  createMockDcapCollateral,
  freshTcbOrQeIdentityJson,
  synthFreshPckCrlBytes,
} from "../mocks/tee-mocks";

// Real withRetry here (unlike tee.test.ts) so the per-endpoint retry budget,
// the dcap-qvl-shaped retry predicate and the soft timeout are exercised;
// timers are faked to keep it fast.
const mockGetCollateral = vi.fn();
const mockQuoteParse = vi.fn();
vi.mock("@phala/dcap-qvl", () => ({
  getCollateral: (...args: unknown[]) => mockGetCollateral(...args),
  Quote: { parse: (...args: unknown[]) => mockQuoteParse(...args) },
  PHALA_PCCS_URL: "https://pccs.phala.network",
  INTEL_PCS_URL: "https://api.trustedservices.intel.com",
}));

const QUOTE = Buffer.from("00", "hex");
const NOW = new Date("2026-05-22T12:00:00Z");

// Error shapes exactly as @phala/dcap-qvl throws them: plain Error, status
// only in the message, no `.status` field.
const dcapHttpError = (what: string, status: number) =>
  new Error(`Failed to fetch ${what}: ${status}`);

function fresh() {
  const at = new Date(NOW.getTime() - 60 * 60 * 1000);
  return createMockDcapCollateral({
    tcb_info: freshTcbOrQeIdentityJson(at),
    qe_identity: freshTcbOrQeIdentityJson(at),
    pck_crl: synthFreshPckCrlBytes(at),
  });
}

function stale() {
  const longAgo = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
  return createMockDcapCollateral({
    tcb_info: freshTcbOrQeIdentityJson(longAgo),
    qe_identity: freshTcbOrQeIdentityJson(longAgo),
    pck_crl: synthFreshPckCrlBytes(longAgo),
  });
}

async function settle(promise: Promise<unknown>): Promise<AggregateError> {
  return promise.then(
    () => {
      throw new Error("expected rejection");
    },
    (e: unknown) => e as AggregateError,
  );
}

describe("fetchCollateralWithFallback", () => {
  beforeEach(() => {
    mockGetCollateral.mockReset();
    mockQuoteParse.mockReset();
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("exports the Phala-then-Intel default ladder", () => {
    expect(DEFAULT_PCCS_ENDPOINTS).toEqual([
      "https://pccs.phala.network",
      "https://api.trustedservices.intel.com",
    ]);
  });

  it("rejects an empty endpoint list before touching the network", async () => {
    await expect(
      fetchCollateralWithFallback([], QUOTE, NOW),
    ).rejects.toThrow("pccsEndpoints must be a non-empty array");
    expect(mockQuoteParse).not.toHaveBeenCalled();
    expect(mockGetCollateral).not.toHaveBeenCalled();
  });

  it("fails fast on a malformed quote without contacting any endpoint", async () => {
    mockQuoteParse.mockImplementation(() => {
      throw new Error("Not enough data to fill buffer");
    });

    await expect(
      fetchCollateralWithFallback(
        ["https://a.example", "https://b.example"],
        QUOTE,
        NOW,
      ),
    ).rejects.toThrow("Not enough data to fill buffer");
    expect(mockQuoteParse).toHaveBeenCalledWith(QUOTE);
    expect(mockGetCollateral).not.toHaveBeenCalled();
  });

  it("retries a failing endpoint once before moving on", async () => {
    mockGetCollateral
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce(fresh());

    const pending = fetchCollateralWithFallback(["https://a.example"], QUOTE, NOW);
    await vi.advanceTimersByTimeAsync(600); // > 500 ms retry delay
    const collateral = await pending;

    expect(mockGetCollateral).toHaveBeenCalledTimes(2);
    expect(mockGetCollateral.mock.calls.every((c) => c[0] === "https://a.example")).toBe(true);
    expect(collateral.tcb_info).toContain("issueDate");
  });

  it("retries a 5xx-shaped dcap-qvl error once", async () => {
    mockGetCollateral
      .mockRejectedValueOnce(dcapHttpError("PCK CRL", 503))
      .mockResolvedValueOnce(fresh());

    const pending = fetchCollateralWithFallback(["https://a.example"], QUOTE, NOW);
    await vi.advanceTimersByTimeAsync(600);
    await pending;

    expect(mockGetCollateral).toHaveBeenCalledTimes(2);
  });

  it.each([404, 400, 403])(
    "does not retry a %i-shaped dcap-qvl error and falls through to the next endpoint",
    async (status) => {
      mockGetCollateral
        .mockRejectedValueOnce(dcapHttpError("TCB info", status))
        .mockResolvedValueOnce(fresh());

      const collateral = await fetchCollateralWithFallback(
        ["https://a.example", "https://b.example"],
        QUOTE,
        NOW,
      );

      expect(mockGetCollateral).toHaveBeenCalledTimes(2);
      expect(mockGetCollateral.mock.calls[0][0]).toBe("https://a.example");
      expect(mockGetCollateral.mock.calls[1][0]).toBe("https://b.example");
      expect(collateral).toBeDefined();
    },
  );

  it.each([408, 429])("still retries a %i-shaped dcap-qvl error", async (status) => {
    mockGetCollateral
      .mockRejectedValueOnce(dcapHttpError("QE identity", status))
      .mockResolvedValueOnce(fresh());

    const pending = fetchCollateralWithFallback(["https://a.example"], QUOTE, NOW);
    await vi.advanceTimersByTimeAsync(600);
    await pending;

    expect(mockGetCollateral).toHaveBeenCalledTimes(2);
  });

  it("times out a hanging endpoint and falls through", async () => {
    mockGetCollateral
      .mockImplementationOnce(() => new Promise(() => {})) // never settles
      .mockImplementationOnce(() => new Promise(() => {})) // retry also hangs
      .mockResolvedValueOnce(fresh());

    const pending = fetchCollateralWithFallback(
      ["https://hang.example", "https://b.example"],
      QUOTE,
      NOW,
    );
    // Two 10 s attempts on the hanging endpoint plus the 500 ms retry delay.
    await vi.advanceTimersByTimeAsync(10_000 + 500 + 10_000 + 1);
    const collateral = await pending;

    expect(mockGetCollateral).toHaveBeenCalledTimes(3);
    expect(mockGetCollateral.mock.calls[2][0]).toBe("https://b.example");
    expect(collateral).toBeDefined();
  });

  it("treats stale collateral as a failure and reports it in the aggregate", async () => {
    mockGetCollateral.mockResolvedValue(stale());

    const settled = await settle(
      fetchCollateralWithFallback(["https://a.example"], QUOTE, NOW),
    );

    expect(settled).toBeInstanceOf(AggregateError);
    expect(settled.message).toContain("All 1 PCCS endpoints failed");
    expect(settled.message).toContain("https://a.example");
    expect(settled.message).toContain("tcb_info is stale");
    expect(settled.errors).toHaveLength(1);
    expect((settled.errors[0] as { field?: string }).field).toBe("tcb_info");
    // Stale collateral is deterministic — no retry on the same endpoint.
    expect(mockGetCollateral).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["null", null],
    ["a non-object", "not collateral"],
    ["an object missing tcb_info", { ...fresh(), tcb_info: undefined }],
    ["an object missing pck_crl", { ...fresh(), pck_crl: undefined }],
    ["a non-hex pck_crl string", { ...fresh(), pck_crl: "zz" }],
    ["a non-JSON qe_identity", { ...fresh(), qe_identity: "{nope" }],
  ])("falls through when an endpoint returns %s", async (_label, value) => {
    mockGetCollateral
      .mockResolvedValueOnce(value)
      .mockResolvedValueOnce(fresh());

    const collateral = await fetchCollateralWithFallback(
      ["https://a.example", "https://b.example"],
      QUOTE,
      NOW,
    );

    expect(mockGetCollateral).toHaveBeenCalledTimes(2);
    expect(mockGetCollateral.mock.calls[1][0]).toBe("https://b.example");
    expect(collateral.tcb_info).toContain("issueDate");
  });

  it("aggregates one error per endpoint, in order, when all fail", async () => {
    mockGetCollateral
      .mockRejectedValueOnce(dcapHttpError("PCK CRL", 503))
      .mockRejectedValueOnce(dcapHttpError("PCK CRL", 502))
      .mockRejectedValueOnce(dcapHttpError("TCB info", 404));

    const pending = settle(
      fetchCollateralWithFallback(
        ["https://a.example", "https://b.example"],
        QUOTE,
        NOW,
      ),
    );
    await vi.advanceTimersByTimeAsync(600);
    const settled = await pending;

    expect(settled).toBeInstanceOf(AggregateError);
    expect(settled.errors).toHaveLength(2);
    expect((settled.errors[0] as Error).message).toBe("Failed to fetch PCK CRL: 502");
    expect((settled.errors[1] as Error).message).toBe("Failed to fetch TCB info: 404");
    expect(settled.message).toContain("[1/2] https://a.example: Failed to fetch PCK CRL: 502");
    expect(settled.message).toContain("[2/2] https://b.example: Failed to fetch TCB info: 404");
    expect(mockGetCollateral).toHaveBeenCalledTimes(3);
  });

  it("logs once when a fallback endpoint succeeds", async () => {
    mockGetCollateral
      .mockRejectedValueOnce(dcapHttpError("TCB info", 404))
      .mockResolvedValueOnce(fresh());

    await fetchCollateralWithFallback(
      ["https://a.example", "https://b.example"],
      QUOTE,
      NOW,
    );

    expect(console.info).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.info).mock.calls[0][0]).toContain("https://b.example");
  });

  it("does not log when the first endpoint succeeds", async () => {
    mockGetCollateral.mockResolvedValueOnce(fresh());

    await fetchCollateralWithFallback(["https://a.example"], QUOTE, NOW);

    expect(console.info).not.toHaveBeenCalled();
  });
});
