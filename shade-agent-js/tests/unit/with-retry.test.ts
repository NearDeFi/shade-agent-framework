import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry, defaultRetryable } from "../../src/utils/errors";

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns on first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    await expect(withRetry(fn)).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries up to N times then throws sanitised", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(new Error("fetch failed ed25519:ZZTESTSECRETZZ"));
    const settled = withRetry(fn, { attempts: 3, delayMs: 0 }).then(
      () => "ok",
      (e) => e as Error,
    );
    await vi.runAllTimersAsync();
    const result = await settled;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("[REDACTED]");
    expect((result as Error).message).not.toContain("ZZTESTSECRET");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry plain TypeError (programmer error)", async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError("bad input"));
    await expect(withRetry(fn, { attempts: 3, delayMs: 0 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries TypeError with .cause (undici fetch failure)", async () => {
    // Node fetch rejects with TypeError("fetch failed") whose .cause carries
    // the real network error. This must be retryable.
    const networkErr = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    const fetchTypeError = Object.assign(new TypeError("fetch failed"), {
      cause: networkErr,
    });
    const fn = vi
      .fn()
      .mockRejectedValueOnce(fetchTypeError)
      .mockResolvedValueOnce("ok");
    const promise = withRetry(fn, { attempts: 3, delayMs: 0 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry HTTP 401", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }));
    await expect(withRetry(fn, { attempts: 3, delayMs: 0 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries HTTP 429 (rate limited)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("rate limited"), { status: 429 }),
      )
      .mockResolvedValueOnce("ok");
    const promise = withRetry(fn, { attempts: 3, delayMs: 0 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries HTTP 503 (server error)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("server error"), { status: 503 }),
      )
      .mockResolvedValueOnce("ok");
    const promise = withRetry(fn, { attempts: 3, delayMs: 0 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry deterministic NEAR TypedError (AccountDoesNotExist)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("missing"), { type: "AccountDoesNotExist" }),
      );
    await expect(withRetry(fn, { attempts: 3, delayMs: 0 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries non-deterministic NEAR TypedError (Timeout)", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("timeout"), { type: "Timeout" }),
      )
      .mockResolvedValueOnce("ok");
    const promise = withRetry(fn, { attempts: 3, delayMs: 0 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("honours custom `retryable` predicate", async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError("normally not retried"));
    const settled = withRetry(fn, {
      attempts: 3,
      delayMs: 0,
      retryable: () => true, // force retry even on TypeError
    }).then(
      () => "ok",
      (e) => e as Error,
    );
    await vi.runAllTimersAsync();
    expect(await settled).toBeInstanceOf(Error);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retryable: () => false disables retry", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("anything"));
    await expect(
      withRetry(fn, { retryable: () => false }),
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("honours delayMs array schedule", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient 1"))
      .mockRejectedValueOnce(new Error("transient 2"))
      .mockResolvedValueOnce("ok");
    const promise = withRetry(fn, {
      attempts: 3,
      delayMs: [100, 200],
    });
    // First attempt fails immediately, then 100ms sleep, attempt 2 fails,
    // then 200ms sleep, attempt 3 succeeds.
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200);
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("aborts on signal.aborted before retry", async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error("network fail"));
    const settled = withRetry(fn, {
      attempts: 3,
      delayMs: 100,
      signal: controller.signal,
    }).then(
      () => "ok",
      (e) => e as Error,
    );
    // Let first attempt run, then abort during the sleep.
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    const result = await settled;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe("aborted");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("rethrows sanitised error on final attempt failure", async () => {
    const fn = vi
      .fn()
      .mockRejectedValue(
        new Error("Failed with key ed25519:ZZTESTSECRETSomeLeakyValue"),
      );
    const settled = withRetry(fn, { attempts: 2, delayMs: 0 }).then(
      () => "ok",
      (e) => e as Error,
    );
    await vi.runAllTimersAsync();
    const result = await settled;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("[REDACTED]");
    expect((result as Error).message).not.toContain("ZZTESTSECRET");
  });
});

describe("defaultRetryable", () => {
  it("retries on generic Error", () => {
    expect(defaultRetryable(new Error("network blip"))).toBe(true);
  });

  it("does not retry plain TypeError (no cause)", () => {
    expect(defaultRetryable(new TypeError("bad arg"))).toBe(false);
  });

  it("retries TypeError with cause (fetch-failed wrapper)", () => {
    const t = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNRESET" },
    });
    expect(defaultRetryable(t)).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])("does not retry on HTTP %i", (status) => {
    expect(defaultRetryable(Object.assign(new Error("x"), { status }))).toBe(false);
  });

  it.each([408, 429, 500, 502, 503, 504])(
    "retries on HTTP %i",
    (status) => {
      expect(defaultRetryable(Object.assign(new Error("x"), { status }))).toBe(true);
    },
  );

  it.each([
    "AccountDoesNotExist",
    "InvalidAccessKey",
    "InvalidSignature",
    "NotEnoughBalance",
    "MethodNotFound",
    "TooLargeContractState",
  ])("does not retry on deterministic NEAR type '%s'", (type) => {
    expect(defaultRetryable(Object.assign(new Error("x"), { type }))).toBe(false);
  });

  it("retries on unknown NEAR type", () => {
    expect(
      defaultRetryable(Object.assign(new Error("x"), { type: "SomethingNew" })),
    ).toBe(true);
  });
});
