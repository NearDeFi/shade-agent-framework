/**
 * Unit tests for src/utils/ppids.js
 *
 * Coverage:
 *  - getPpids(false): returns the local-mode placeholder PPID without fetching.
 *  - getPpids(true) on 200 + array: returns the array verbatim.
 *  - getPpids(true) on non-OK: chalk.red + process.exit(1).
 *  - getPpids(true) on non-array body: chalk.red + process.exit(1).
 *
 * Notes:
 *  - global.fetch is mocked per-test.
 *  - process.exit is spied so abort assertions work without terminating
 *    the test runner.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { getPpids } from "../../src/utils/ppids.js";

describe("getPpids", () => {
  let exitSpy;
  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  // Local mode never hits the network; returns a single zero-PPID sentinel.
  it("returns the local PPID when isTee is false", async () => {
    expect(await getPpids(false)).toEqual([
      "00000000000000000000000000000000",
    ]);
  });

  // Happy TEE path: 200 + JSON array → returned verbatim.
  it("returns the fetched array on a 200 response", async () => {
    const ppids = ["a", "b"];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ppids,
    });
    expect(await getPpids(true)).toEqual(ppids);
  });

  // 5xx is a hard failure — abort with exit 1 rather than register against
  // an empty PPID list.
  it("exits 1 on a non-OK response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    });
    await expect(getPpids(true)).rejects.toThrow("exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // Non-array body is a contract break — never silently coerce or wrap.
  it("exits 1 when the response body isn't an array", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ unexpected: "shape" }),
    });
    await expect(getPpids(true)).rejects.toThrow("exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
