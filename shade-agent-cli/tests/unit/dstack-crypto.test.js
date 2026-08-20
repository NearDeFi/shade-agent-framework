/**
 * Unit tests for the env-var encryption the self-hosted dstack backend relies on.
 *
 * The CLI encrypts the env file locally and hands the VMM only the blob, so the
 * host never sees plaintext. The only consumer is `dh_decrypt` in the guest
 * (dstack-util/src/crypto.rs): `blob[0..32]` ephemeral X25519 public key,
 * `blob[32..44]` IV, `blob[44..]` AES-256-GCM ciphertext, with the raw X25519
 * shared secret as the key — no KDF, no AAD. That is ported to node:crypto here
 * and used as the oracle, so these tests prove the guest can actually read what
 * we send rather than just that we produced some bytes.
 *
 * Coverage:
 *  - exact round trip through the real consumer, including newlines, quotes,
 *    shell metacharacters, unicode and a 100 KB value.
 *  - fresh ephemeral key AND fresh IV on every call.
 *  - tamper, truncation and wrong-recipient all fail closed.
 *  - no plaintext leaks into the blob.
 *  - malformed recipient public keys are rejected rather than silently
 *    producing an undecryptable blob.
 */
import { describe, it, expect } from "vitest";
import crypto from "crypto";
import { encryptEnvVars } from "@phala/dstack-sdk/encrypt-env-vars";

// X25519 raw <-> DER, so node:crypto can use the raw 32-byte keys the wire
// format carries.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e042204 20".replace(/\s/g, ""), "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

function newRecipient() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return {
    publicKeyHex: publicKey
      .export({ type: "spki", format: "der" })
      .subarray(SPKI_PREFIX.length)
      .toString("hex"),
    privateKeyRaw: privateKey
      .export({ type: "pkcs8", format: "der" })
      .subarray(PKCS8_PREFIX.length),
  };
}

// Port of dstack-util's dh_decrypt.
function dhDecrypt(privateKeyRaw, blobHex) {
  const blob = Buffer.from(blobHex, "hex");
  const ephemeralPub = blob.subarray(0, 32);
  const iv = blob.subarray(32, 44);
  const sealed = blob.subarray(44);
  if (ephemeralPub.length !== 32) throw new Error("Invalid ephemeral public key length");
  if (iv.length !== 12) throw new Error("Invalid IV length");
  if (sealed.length < 16) throw new Error("Invalid ciphertext length");

  const shared = crypto.diffieHellman({
    privateKey: crypto.createPrivateKey({
      key: Buffer.concat([PKCS8_PREFIX, privateKeyRaw]),
      format: "der",
      type: "pkcs8",
    }),
    publicKey: crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, ephemeralPub]),
      format: "der",
      type: "spki",
    }),
  });

  const decipher = crypto.createDecipheriv("aes-256-gcm", shared, iv);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([
    decipher.update(sealed.subarray(0, sealed.length - 16)),
    decipher.final(),
  ]).toString("utf8");
}

function decryptEnvs(privateKeyRaw, blobHex) {
  return JSON.parse(dhDecrypt(privateKeyRaw, blobHex)).env;
}

describe("dstack env encryption round trip", () => {
  const cases = [
    ["a plain value", [{ key: "AGENT_CONTRACT_ID", value: "agent.testnet" }]],
    [
      "a value with newlines",
      [{ key: "PEM", value: "-----BEGIN KEY-----\nline\n\nline\n-----END KEY-----\n" }],
    ],
    [
      "values with quotes and backslashes",
      [
        { key: "QUOTED", value: `he said "hi" and 'bye' \\ done` },
        { key: "JSONISH", value: '{"a":"b","c":["d"]}' },
      ],
    ],
    [
      "shell metacharacters",
      [{ key: "DANGER", value: "$(id); `whoami` && rm -rf / | cat > /tmp/x" }],
    ],
    ["unicode", [{ key: "UNICODE", value: "🔐 ключ — 密鑰 -ish" }]],
    ["a 100 KB value", [{ key: "BIG", value: "x".repeat(100 * 1024) }]],
    [
      "many variables at once",
      Array.from({ length: 64 }, (_, i) => ({ key: `VAR_${i}`, value: `v${i}` })),
    ],
  ];

  for (const [label, envs] of cases) {
    it(`round trips ${label} through the guest's decryptor`, async () => {
      const recipient = newRecipient();
      const blob = await encryptEnvVars(envs, recipient.publicKeyHex);
      expect(decryptEnvs(recipient.privateKeyRaw, blob)).toEqual(envs);
    });
  }

  // Reusing an ephemeral key or an IV under the same key would leak plaintext
  // relationships, so both must be fresh per call.
  it("uses a fresh ephemeral public key on every call", async () => {
    const recipient = newRecipient();
    const envs = [{ key: "K", value: "v" }];
    const keys = new Set();
    for (let i = 0; i < 8; i++) {
      const blob = await encryptEnvVars(envs, recipient.publicKeyHex);
      keys.add(blob.slice(0, 64));
    }
    expect(keys.size).toBe(8);
  });

  it("uses a fresh IV on every call", async () => {
    const recipient = newRecipient();
    const envs = [{ key: "K", value: "v" }];
    const ivs = new Set();
    for (let i = 0; i < 8; i++) {
      const blob = await encryptEnvVars(envs, recipient.publicKeyHex);
      ivs.add(blob.slice(64, 88));
    }
    expect(ivs.size).toBe(8);
  });

  it("fails closed when the ciphertext is tampered with", async () => {
    const recipient = newRecipient();
    const blob = await encryptEnvVars([{ key: "K", value: "v" }], recipient.publicKeyHex);
    const bytes = Buffer.from(blob, "hex");
    bytes[50] ^= 0xff;
    expect(() => dhDecrypt(recipient.privateKeyRaw, bytes.toString("hex"))).toThrow();
  });

  it("fails closed when the IV is tampered with", async () => {
    const recipient = newRecipient();
    const blob = await encryptEnvVars([{ key: "K", value: "v" }], recipient.publicKeyHex);
    const bytes = Buffer.from(blob, "hex");
    bytes[35] ^= 0xff;
    expect(() => dhDecrypt(recipient.privateKeyRaw, bytes.toString("hex"))).toThrow();
  });

  it("fails closed when the blob is truncated", async () => {
    const recipient = newRecipient();
    const blob = await encryptEnvVars([{ key: "K", value: "v" }], recipient.publicKeyHex);
    const bytes = Buffer.from(blob, "hex");
    for (const cut of [10, 40, 50, bytes.length - 1]) {
      expect(() =>
        dhDecrypt(recipient.privateKeyRaw, bytes.subarray(0, cut).toString("hex")),
      ).toThrow();
    }
  });

  // The whole point of encrypting locally: only the app whose app_id the KMS
  // derived the key for can read it.
  it("cannot be decrypted by a different recipient", async () => {
    const recipient = newRecipient();
    const other = newRecipient();
    const blob = await encryptEnvVars([{ key: "K", value: "secret" }], recipient.publicKeyHex);
    expect(() => dhDecrypt(other.privateKeyRaw, blob)).toThrow();
  });

  it("leaves no plaintext in the blob", async () => {
    const recipient = newRecipient();
    const secret = "ed25519:3xVerySecretPrivateKeyMaterial";
    const blob = await encryptEnvVars(
      [{ key: "SPONSOR_PRIVATE_KEY", value: secret }],
      recipient.publicKeyHex,
    );
    const raw = Buffer.from(blob, "hex").toString("latin1");
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("SPONSOR_PRIVATE_KEY");
    expect(blob).not.toContain(Buffer.from(secret).toString("hex"));
  });

  // A malformed pubkey must throw rather than yield a blob nothing can read.
  // All-zeros is the interesting one: it is a low-order point and is refused.
  const badKeys = {
    "31 bytes": "00".repeat(30) + "01",
    "33 bytes": "11".repeat(33),
    empty: "",
    "all zeros": "00".repeat(32),
    "non-hex": "z".repeat(64),
  };
  for (const [label, key] of Object.entries(badKeys)) {
    it(`rejects a recipient public key that is ${label}`, async () => {
      await expect(
        encryptEnvVars([{ key: "K", value: "v" }], key),
      ).rejects.toThrow();
    });
  }
});
