/**
 * Unit tests for src/utils/dstack-kms.js
 *
 * Crypto is real; only the SSH transport is mocked.
 *
 * The important property under test is that `getAppEnvEncryptPubKey` PINS the
 * recovered signer to the KMS's own k256 public key. Recovery on its own proves
 * nothing — every well-formed 65-byte signature recovers *some* public key, so
 * a `!== null` check would accept an attacker-supplied encryption key and the
 * env file would be encrypted to them (vmm-cli.py compares against a whitelist
 * file that is empty by default, prints "Verified" and carries on).
 *
 * Coverage:
 *  - key_provider_event_digest reproduces the value the live box put on chain,
 *    from a committed CA certificate fixture (a public key).
 *  - PPID extraction from the KMS bootstrap attestation fixture, plus the
 *    no-certificate, disagreeing-certificates and wrong-length failures.
 *  - 10 signature cases with the signer pinned: the honest signature is
 *    accepted; attacker key, cross-app-id, pubkey substitution, stale, future,
 *    lying timestamp, 64-byte signature, missing signature, and a KMS with no
 *    k256_pubkey are all rejected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

const kmsRpc = vi.fn();
vi.mock("../../src/utils/dstack-transport.js", () => ({
  kmsRpc: (...args) => kmsRpc(...args),
  KMS_URL: "https://127.0.0.1:11001",
}));

const {
  keyProviderEventDigestFromCaCert,
  getKeyProviderEventDigest,
  extractPpidFromQuote,
  getPpidFromKmsQuote,
  getAppEnvEncryptPubKey,
} = await import("../../src/utils/dstack-kms.js");

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const CA_CERT = fs.readFileSync(path.join(fixtures, "dstack-kms-ca.pem"), "utf8");
const ATTESTATION_HEX = fs
  .readFileSync(path.join(fixtures, "dstack-kms-bootstrap-attestation.hex"), "utf8")
  .trim();

// Read off the live box on 20 Aug, and byte-for-byte what the agent CVM put on
// chain as key_provider_event_digest.
const EXPECTED_DIGEST =
  "4511a19be37d3086d13fcc36106271dad419dbde433876360a5d61f924d9ec8cb1081a2bd4957aa4a23533ca93a48440";
const EXPECTED_PPID = "98d4560c0c8b3be964edbb9310366155";

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const bytes = (hexStr) => Uint8Array.from(Buffer.from(hexStr, "hex"));

function concat(...parts) {
  return Uint8Array.from(Buffer.concat(parts.map((p) => Buffer.from(p))));
}

function beBytes(value, length) {
  const out = Buffer.alloc(length);
  out.writeBigUInt64BE(BigInt(value), length - 8);
  return out;
}

// The same message the KMS signs (kms/src/main_service.rs).
function envPubKeyMessage(publicKey, appId, timestamp) {
  return keccak_256(
    concat(
      Buffer.from("dstack-env-encrypt-pubkey"),
      Buffer.from(":"),
      bytes(appId),
      beBytes(timestamp, 8),
      publicKey,
    ),
  );
}

function signRecoverable(privateKey, messageHash) {
  const sig = secp256k1.sign(messageHash, privateKey);
  return hex(concat(sig.toCompactRawBytes(), Uint8Array.from([sig.recovery])));
}

function newSigner() {
  const privateKey = secp256k1.utils.randomPrivateKey();
  return {
    privateKey,
    pubkeyHex: hex(secp256k1.getPublicKey(privateKey, true)),
  };
}

describe("keyProviderEventDigestFromCaCert", () => {
  // The formula is sha384(u32le(0x08000001) || ":key-provider:" ||
  // {"name":"kms","id":<hex SPKI DER>}) — field order and the absence of spaces
  // both matter, so this pins the exact encoding.
  it("reproduces the digest the live KMS's CA certificate produced", () => {
    expect(keyProviderEventDigestFromCaCert(CA_CERT)).toBe(EXPECTED_DIGEST);
  });

  // The digest is derived from the CA's public key alone, so a re-bootstrapped
  // KMS produces a different one and has to be re-approved.
  it("changes when the CA public key changes", () => {
    const { publicKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const otherKeyPem = publicKey.export({ type: "spki", format: "pem" });
    expect(keyProviderEventDigestFromCaCert(otherKeyPem)).not.toBe(
      EXPECTED_DIGEST,
    );
  });
});

describe("getKeyProviderEventDigest", () => {
  beforeEach(() => {
    kmsRpc.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("computes the digest from the KMS's live CA certificate", () => {
    kmsRpc.mockReturnValue({ ca_cert: CA_CERT });
    expect(getKeyProviderEventDigest("tdx")).toBe(EXPECTED_DIGEST);
    expect(kmsRpc).toHaveBeenCalledWith("tdx", "GetMeta", {});
  });

  it("exits 1 when the KMS has not been bootstrapped", () => {
    kmsRpc.mockReturnValue({ ca_cert: "" });
    expect(() => getKeyProviderEventDigest("tdx")).toThrow("exit:1");
  });
});

describe("extractPpidFromQuote", () => {
  const OID = "060a2a864886f84d010d0101";

  // A certificate carrying just the SGX PPID extension. The parser byte-scans
  // for the OID, so the surrounding SEQUENCE is only there for realism.
  function certWithPpid(valueHex) {
    const value = `04${(valueHex.length / 2).toString(16).padStart(2, "0")}${valueHex}`;
    const inner = `${OID}${value}`;
    const der = Buffer.from(
      `30${(inner.length / 2).toString(16).padStart(2, "0")}${inner}`,
      "hex",
    );
    return [
      "-----BEGIN CERTIFICATE-----",
      der.toString("base64"),
      "-----END CERTIFICATE-----",
    ].join("\n");
  }

  let logSpy;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  // Every failure exits, so the reason only survives in the rendered line.
  const rendered = () => logSpy.mock.calls.flat().join("\n");

  it("reads the 16-byte PPID out of the KMS bootstrap attestation", () => {
    expect(extractPpidFromQuote(Buffer.from(ATTESTATION_HEX, "hex"))).toBe(
      EXPECTED_PPID,
    );
  });

  it("exits 1 when no certificate carries the SGX extension", () => {
    expect(() => extractPpidFromQuote(Buffer.from("deadbeef", "hex"))).toThrow(
      "exit:1",
    );
    expect(rendered()).toMatch(/no PCK certificate/);
  });

  // A spliced chain must not resolve to whichever PPID was found first — that
  // value is what gets approved on chain.
  it("exits 1 when the embedded certificates disagree", () => {
    const quote = Buffer.from(
      [certWithPpid("aa".repeat(16)), certWithPpid("bb".repeat(16))].join("\n"),
    );
    expect(() => extractPpidFromQuote(quote)).toThrow("exit:1");
    expect(rendered()).toMatch(/disagree on the PPID/);
  });

  // A different-length value means the wrong extension was read; the contract's
  // HexBytes<16> would reject it on chain, so catch it here.
  it("exits 1 for a PPID extension that is not 16 bytes", () => {
    expect(() =>
      extractPpidFromQuote(Buffer.from(certWithPpid("aabb"))),
    ).toThrow("exit:1");
    expect(rendered()).toMatch(/2 bytes, expected 16/);
  });
});

describe("getPpidFromKmsQuote", () => {
  beforeEach(() => {
    kmsRpc.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns the box's PPID", () => {
    kmsRpc.mockReturnValue({ bootstrap_info: { attestation: ATTESTATION_HEX } });
    expect(getPpidFromKmsQuote("tdx")).toBe(EXPECTED_PPID);
  });

  // Without quotes enabled the KMS stores an empty attestation; point the
  // operator at the literal-PPID escape hatch rather than approving nothing.
  it("exits 1 with advice when there is no bootstrap attestation", () => {
    kmsRpc.mockReturnValue({ bootstrap_info: { attestation: "" } });
    const logSpy = vi.spyOn(console, "log");
    expect(() => getPpidFromKmsQuote("tdx")).toThrow("exit:1");
    expect(logSpy.mock.calls.flat().join(" ")).toMatch(/approve_ppids\.args/);
  });
});

describe("getAppEnvEncryptPubKey signer pinning", () => {
  const appId = "cb2b32a6b94daa63e29ba2a6abdfa917b19bd149";
  const envPubKey = "073894be8c1622a5b3a0a3ea694eb500564f9cf6d6fdac4e7ee7871bce997b5e";
  let kmsKey;
  let attacker;
  let now;

  function meta(overrides = {}) {
    return { ca_cert: CA_CERT, k256_pubkey: kmsKey.pubkeyHex, ...overrides };
  }

  function signed(signer, { key = envPubKey, id = appId, timestamp = now } = {}) {
    return signRecoverable(
      signer.privateKey,
      envPubKeyMessage(bytes(key), id, timestamp),
    );
  }

  // GetMeta is always the first call, then GetAppEnvEncryptPubKey.
  function respond(metaValue, pubKeyResponse) {
    kmsRpc.mockImplementation((_host, method) =>
      method === "GetMeta" ? metaValue : pubKeyResponse,
    );
  }

  beforeEach(() => {
    kmsRpc.mockReset();
    kmsKey = newSigner();
    attacker = newSigner();
    now = Math.floor(Date.now() / 1000);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("accepts a key signed by the KMS's own k256 key", () => {
    respond(meta(), {
      public_key: envPubKey,
      timestamp: now,
      signature_v1: signed(kmsKey),
    });
    expect(getAppEnvEncryptPubKey("tdx", appId)).toBe(envPubKey);
  });

  // The attack the pin exists for: a well-formed signature from any key
  // recovers fine, so only comparing to the KMS's key catches it.
  it("rejects a key signed by an attacker's key", () => {
    respond(meta(), {
      public_key: envPubKey,
      timestamp: now,
      signature_v1: signed(attacker),
    });
    expect(() => getAppEnvEncryptPubKey("tdx", appId)).toThrow("exit:1");
  });

  it("rejects a signature made over a different app id", () => {
    respond(meta(), {
      public_key: envPubKey,
      timestamp: now,
      signature_v1: signed(kmsKey, { id: "00".repeat(20) }),
    });
    expect(() => getAppEnvEncryptPubKey("tdx", appId)).toThrow("exit:1");
  });

  it("rejects a substituted encryption public key", () => {
    respond(meta(), {
      public_key: "ff".repeat(32),
      timestamp: now,
      signature_v1: signed(kmsKey),
    });
    expect(() => getAppEnvEncryptPubKey("tdx", appId)).toThrow("exit:1");
  });

  // A stale timestamp is a replay; the SDK's window is 300s.
  it("rejects a stale timestamp", () => {
    const stale = now - 4000;
    respond(meta(), {
      public_key: envPubKey,
      timestamp: stale,
      signature_v1: signed(kmsKey, { timestamp: stale }),
    });
    expect(() => getAppEnvEncryptPubKey("tdx", appId)).toThrow("exit:1");
  });

  it("rejects a timestamp far in the future", () => {
    const future = now + 4000;
    respond(meta(), {
      public_key: envPubKey,
      timestamp: future,
      signature_v1: signed(kmsKey, { timestamp: future }),
    });
    expect(() => getAppEnvEncryptPubKey("tdx", appId)).toThrow("exit:1");
  });

  // Signed over one timestamp, reported as another — recovery yields a
  // different key, so the pin catches it.
  it("rejects a timestamp that disagrees with the signed one", () => {
    respond(meta(), {
      public_key: envPubKey,
      timestamp: now,
      signature_v1: signed(kmsKey, { timestamp: now - 10 }),
    });
    expect(() => getAppEnvEncryptPubKey("tdx", appId)).toThrow("exit:1");
  });

  it("rejects a 64-byte signature with no recovery byte", () => {
    const full = signed(kmsKey);
    respond(meta(), {
      public_key: envPubKey,
      timestamp: now,
      signature_v1: full.slice(0, 128),
    });
    expect(() => getAppEnvEncryptPubKey("tdx", appId)).toThrow("exit:1");
  });

  it("rejects a response with no signature at all", () => {
    respond(meta(), { public_key: envPubKey, timestamp: now });
    expect(() => getAppEnvEncryptPubKey("tdx", appId)).toThrow("exit:1");
  });

  it("refuses to proceed when the KMS reports no k256_pubkey to pin to", () => {
    respond(meta({ k256_pubkey: "" }), {
      public_key: envPubKey,
      timestamp: now,
      signature_v1: signed(kmsKey),
    });
    expect(() => getAppEnvEncryptPubKey("tdx", appId)).toThrow("exit:1");
  });

  // signature_v1 is preferred, but a KMS old enough to only send the legacy
  // signature still has to clear the same pin.
  it("falls back to the legacy signature and still pins the signer", () => {
    const legacyHash = keccak_256(
      concat(
        Buffer.from("dstack-env-encrypt-pubkey"),
        Buffer.from(":"),
        bytes(appId),
        bytes(envPubKey),
      ),
    );
    respond(meta(), {
      public_key: envPubKey,
      signature: signRecoverable(kmsKey.privateKey, legacyHash),
    });
    expect(getAppEnvEncryptPubKey("tdx", appId)).toBe(envPubKey);
  });

  it("rejects a legacy signature from an attacker's key", () => {
    const legacyHash = keccak_256(
      concat(
        Buffer.from("dstack-env-encrypt-pubkey"),
        Buffer.from(":"),
        bytes(appId),
        bytes(envPubKey),
      ),
    );
    respond(meta(), {
      public_key: envPubKey,
      signature: signRecoverable(attacker.privateKey, legacyHash),
    });
    expect(() => getAppEnvEncryptPubKey("tdx", appId)).toThrow("exit:1");
  });
});
