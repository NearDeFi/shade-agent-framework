/**
 * Unit tests for src/utils/ppids.js
 *
 * Coverage:
 *  - local environment: returns the local-mode placeholder PPID without fetching.
 *  - phala backend on 200 + array: returns the array verbatim.
 *  - phala backend on non-OK: chalk.red + process.exit(1).
 *  - phala backend on non-array body: chalk.red + process.exit(1).
 *  - dstack backend: reads the single PPID off the server's KMS, never fetches.
 *
 * Notes:
 *  - global.fetch is mocked per-test.
 *  - process.exit is spied so abort assertions work without terminating
 *    the test runner.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const getPpidFromKmsQuote = vi.fn();
vi.mock("../../src/utils/dstack-kms.js", () => ({
  getPpidFromKmsQuote: (...args) => getPpidFromKmsQuote(...args),
}));

const { getPpids } = await import("../../src/utils/ppids.js");

const local = { environment: "local" };
const phala = { environment: "TEE", tee_config: { backend: "phala" } };
const dstack = {
  environment: "TEE",
  tee_config: { backend: "server", server: { ssh_host: "tdx" } },
};

describe("getPpids", () => {
  let exitSpy;
  beforeEach(() => {
    getPpidFromKmsQuote.mockReset();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  // Local mode never hits the network; returns a single zero-PPID sentinel.
  it("returns the local PPID when the environment is local", async () => {
    global.fetch = vi.fn();
    expect(await getPpids(local)).toEqual([
      "00000000000000000000000000000000",
    ]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // Happy TEE path: 200 + JSON array → returned verbatim.
  it("returns the fetched array on a 200 response", async () => {
    const ppids = ["a", "b"];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ppids,
    });
    expect(await getPpids(phala)).toEqual(ppids);
  });

  // 5xx is a hard failure — abort with exit 1 rather than register against
  // an empty PPID list.
  it("exits 1 on a non-OK response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    });
    await expect(getPpids(phala)).rejects.toThrow("exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // Phala's fleet API can list the same PPID twice. `approve_ppids` tolerates
  // that (a set insert is a no-op) but `remove_ppids` require!s every removal
  // to succeed, so the second occurrence panics with "PPID not in approved
  // list". Dedupe here, where the bad data enters.
  it("dedupes the Phala response, preserving first-seen order", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ["b", "a", "b", "c", "a"],
    });
    expect(await getPpids(phala)).toEqual(["b", "a", "c"]);
  });

  // Non-array body is a contract break — never silently coerce or wrap.
  it("exits 1 when the response body isn't an array", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ unexpected: "shape" }),
    });
    await expect(getPpids(phala)).rejects.toThrow("exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // A self-hosted box has exactly one PPID and Phala's API knows nothing
  // about it, so the KMS is the only source.
  it("reads the PPID off the server's KMS for the dstack backend", async () => {
    global.fetch = vi.fn();
    getPpidFromKmsQuote.mockReturnValue("98d4560c0c8b3be964edbb9310366155");
    expect(await getPpids(dstack)).toEqual([
      "98d4560c0c8b3be964edbb9310366155",
    ]);
    expect(getPpidFromKmsQuote).toHaveBeenCalledWith("tdx");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
