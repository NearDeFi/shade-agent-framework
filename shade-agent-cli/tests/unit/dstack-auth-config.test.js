/**
 * Unit tests for src/utils/dstack-auth-config.js
 *
 * The CLI writes the KMS's own allowlist, and auth-simple is inside the threat
 * model — a merge that dropped `osImages`, the `kms` block or a sibling app
 * would lock the KMS or the gateway out of their keys on the next boot. So the
 * merge is a pure function and is tested adversarially.
 *
 * Coverage:
 *  - every sibling key and app survives the merge.
 *  - the merge is pure (input untouched) and idempotent (no write on a re-run).
 *  - `__proto__` / `constructor` as app ids become own keys, not prototypes.
 *  - an unparseable or non-object file refuses to write.
 *  - upgrading an existing app appends the new compose hash and keeps the old.
 *  - the app id written is the app id passed in, 0x-prefixed and lowercased.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sshReadFile = vi.fn();
const sshWriteFileAsShade = vi.fn();
vi.mock("../../src/utils/dstack-transport.js", () => ({
  sshReadFile: (...args) => sshReadFile(...args),
  sshWriteFileAsShade: (...args) => sshWriteFileAsShade(...args),
  AUTH_CONFIG_PATH: "/opt/shade/kms/auth-config.json",
}));

const { mergeAppEntry, allowlistApp } = await import(
  "../../src/utils/dstack-auth-config.js"
);

// The shape the live box carries: the KMS block, the OS image allowlist, the
// gateway app id, and the gateway's own app entry.
const existing = {
  osImages: ["0x6427f4f5ded88b72d326bd973e581c1689c5080c6444a0cf90fec7d9e4c8b92a"],
  kms: { allowAnyDevice: true },
  gatewayAppId: "0x9ac2a26c51503b3a61020a7f9385001aeb42a5bd",
  apps: {
    "0x9ac2a26c51503b3a61020a7f9385001aeb42a5bd": {
      composeHashes: ["0x9e266c1f6b979899d6bffb2871b0e588ac9261b8171fe8315954ec2132a7237a"],
      devices: [],
      allowAnyDevice: true,
    },
    "0xbe0c9b5d351304269e221430d864dc771c9c570b": {
      composeHashes: ["0x0a59ee8121ba0491f4d942aef270e0741a20563893c1307e1f09f01a8d6806f4"],
      devices: [],
      allowAnyDevice: true,
    },
  },
};

const APP_ID = "cb2b32a6b94daa63e29ba2a6abdfa917b19bd149";
const HASH = "a".repeat(64);
const MARKER = "my-test-agent 2026-08-20T12:00:00.000Z";

describe("mergeAppEntry", () => {
  it("keeps osImages, kms, gatewayAppId and every sibling app", () => {
    const merged = mergeAppEntry(existing, APP_ID, HASH, MARKER);
    expect(merged.osImages).toEqual(existing.osImages);
    expect(merged.kms).toEqual(existing.kms);
    expect(merged.gatewayAppId).toBe(existing.gatewayAppId);
    for (const id of Object.keys(existing.apps)) {
      expect(merged.apps[id]).toEqual(existing.apps[id]);
    }
  });

  it("adds the app entry auth-simple expects", () => {
    const merged = mergeAppEntry(existing, APP_ID, HASH, MARKER);
    expect(merged.apps[`0x${APP_ID}`]).toEqual({
      composeHashes: [`0x${HASH}`],
      devices: [],
      allowAnyDevice: true,
      _shade: MARKER,
    });
  });

  it("does not mutate the config it was given", () => {
    const snapshot = JSON.parse(JSON.stringify(existing));
    mergeAppEntry(existing, APP_ID, HASH, MARKER);
    expect(existing).toEqual(snapshot);
  });

  it("0x-prefixes and lowercases the app id and hash", () => {
    const merged = mergeAppEntry(existing, APP_ID.toUpperCase(), HASH.toUpperCase(), MARKER);
    expect(merged.apps[`0x${APP_ID}`].composeHashes).toEqual([`0x${HASH}`]);
  });

  // On an image change the old hash is kept so the previous CVM can still boot.
  it("appends a new compose hash to an existing app and keeps the old one", () => {
    const first = mergeAppEntry(existing, APP_ID, HASH, MARKER);
    const second = mergeAppEntry(first, APP_ID, "b".repeat(64), "later");
    expect(second.apps[`0x${APP_ID}`].composeHashes).toEqual([
      `0x${HASH}`,
      `0x${"b".repeat(64)}`,
    ]);
  });

  it("does not duplicate a compose hash already present", () => {
    const first = mergeAppEntry(existing, APP_ID, HASH, MARKER);
    const second = mergeAppEntry(first, APP_ID, HASH, MARKER);
    expect(second.apps[`0x${APP_ID}`].composeHashes).toEqual([`0x${HASH}`]);
  });

  it("works when the file has no apps map yet", () => {
    const merged = mergeAppEntry({ osImages: [] }, APP_ID, HASH, MARKER);
    expect(Object.keys(merged.apps)).toEqual([`0x${APP_ID}`]);
  });

  // `__proto__` survives JSON.parse as an own key, so a naive assignment merge
  // would set a prototype instead of an entry and silently drop the app.
  for (const nasty of ["__proto__", "constructor", "prototype"]) {
    it(`treats an existing "${nasty}" app id as data, not a prototype`, () => {
      const parsed = JSON.parse(
        `{"apps":{"${nasty}":{"composeHashes":["0x${"c".repeat(64)}"],"devices":[],"allowAnyDevice":true}}}`,
      );
      const merged = mergeAppEntry(parsed, APP_ID, HASH, MARKER);
      expect(Object.prototype.hasOwnProperty.call(merged.apps, nasty)).toBe(true);
      expect(merged.apps[`0x${APP_ID}`].composeHashes).toEqual([`0x${HASH}`]);
      expect({}.polluted).toBeUndefined();
      expect(Object.getPrototypeOf(merged.apps)).toBe(Object.prototype);
    });
  }
});

describe("allowlistApp", () => {
  beforeEach(() => {
    sshReadFile.mockReset();
    sshWriteFileAsShade.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("writes the merged config back and reports it wrote", () => {
    sshReadFile.mockReturnValue(JSON.stringify(existing, null, 2) + "\n");
    expect(allowlistApp("tdx", APP_ID, HASH, MARKER)).toEqual({ written: true });
    const written = JSON.parse(sshWriteFileAsShade.mock.calls[0][2]);
    expect(written.apps[`0x${APP_ID}`].composeHashes).toEqual([`0x${HASH}`]);
    expect(Object.keys(written.apps)).toHaveLength(3);
  });

  // The app id allowlisted must be the one the deploy is about to use.
  it("allowlists exactly the app id it was given", () => {
    sshReadFile.mockReturnValue(JSON.stringify(existing, null, 2) + "\n");
    allowlistApp("tdx", APP_ID, HASH, MARKER);
    const written = JSON.parse(sshWriteFileAsShade.mock.calls[0][2]);
    const added = Object.keys(written.apps).filter(
      (id) => !Object.keys(existing.apps).includes(id),
    );
    expect(added).toEqual([`0x${APP_ID}`]);
  });

  it("writes nothing when the entry is already there byte-for-byte", () => {
    const already = mergeAppEntry(existing, APP_ID, HASH, MARKER);
    sshReadFile.mockReturnValue(JSON.stringify(already, null, 2) + "\n");
    expect(allowlistApp("tdx", APP_ID, HASH, MARKER)).toEqual({ written: false });
    expect(sshWriteFileAsShade).not.toHaveBeenCalled();
  });

  // Overwriting a file we could not parse would wipe the KMS's own allowlist.
  it("refuses to write when the existing file is not valid JSON", () => {
    sshReadFile.mockReturnValue("{ this is not json");
    expect(() => allowlistApp("tdx", APP_ID, HASH, MARKER)).toThrow("exit:1");
    expect(sshWriteFileAsShade).not.toHaveBeenCalled();
  });

  it("refuses to write when the existing file is not a JSON object", () => {
    for (const body of ["[]", '"nope"', "42", "null"]) {
      sshReadFile.mockReturnValue(body);
      expect(() => allowlistApp("tdx", APP_ID, HASH, MARKER)).toThrow("exit:1");
    }
    expect(sshWriteFileAsShade).not.toHaveBeenCalled();
  });
});
