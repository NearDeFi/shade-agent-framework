import crypto from "crypto";
import chalk from "chalk";
import {
  verifyEnvEncryptPublicKey,
  verifyEnvEncryptPublicKeyLegacy,
} from "@phala/dstack-sdk";
import { kmsRpc, KMS_URL } from "./dstack-transport.js";

// dstack's runtime event type, extended into RTMR3 for the key-provider event
// (cc-eventlog/src/runtime_events.rs).
const DSTACK_RUNTIME_EVENT_TYPE = 0x08000001;

// SGX extension OID 1.2.840.113741.1.13.1.1 (PPID), DER-encoded.
const PPID_OID = Buffer.from("060a2a864886f84d010d0101", "hex");
const PPID_LENGTH = 16;

function fail(message) {
  console.log(chalk.red(`Error: ${message}`));
  process.exit(1);
}

function getMeta(sshHost) {
  const meta = kmsRpc(sshHost, "GetMeta", {});
  if (!meta || typeof meta !== "object") {
    fail(`KMS.GetMeta on ${KMS_URL} returned no metadata`);
  }
  return meta;
}

/**
 * The digest the guest extends into RTMR3 for the key provider, which is what
 * the agent contract pins as key_provider_event_digest. In KMS mode the payload
 * is {"name":"kms","id":<hex SPKI DER of the KMS root CA public key>} and the
 * digest is sha384(u32le(event_type) || ":key-provider:" || payload).
 */
export function keyProviderEventDigestFromCaCert(caCertPem) {
  let spkiDer;
  try {
    spkiDer = crypto
      .createPublicKey(caCertPem)
      .export({ type: "spki", format: "der" });
  } catch (e) {
    fail(`could not read the public key out of the KMS CA certificate: ${e.message}`);
  }
  const payload = Buffer.from(
    JSON.stringify({ name: "kms", id: spkiDer.toString("hex") }),
  );
  const eventType = Buffer.alloc(4);
  eventType.writeUInt32LE(DSTACK_RUNTIME_EVENT_TYPE);
  return crypto
    .createHash("sha384")
    .update(Buffer.concat([eventType, Buffer.from(":key-provider:"), payload]))
    .digest("hex");
}

export function getKeyProviderEventDigest(sshHost) {
  const meta = getMeta(sshHost);
  if (typeof meta.ca_cert !== "string" || !meta.ca_cert.includes("BEGIN CERTIFICATE")) {
    fail(`KMS.GetMeta on ${KMS_URL} returned no ca_cert; the KMS has not been bootstrapped`);
  }
  return keyProviderEventDigestFromCaCert(meta.ca_cert);
}

function failPpid(reason) {
  fail(
    `could not read a PPID out of the KMS bootstrap attestation: ${reason}. ` +
      `Put the PPID directly in approve_ppids.args instead.`,
  );
}

/**
 * Read the PPID out of the PCK certificates embedded in a TDX quote. Only the
 * leaf PCK cert carries the SGX extension; the intermediates do not, and every
 * cert that does carry it must agree.
 */
export function extractPpidFromQuote(quoteBytes) {
  const certs =
    Buffer.from(quoteBytes)
      .toString("latin1")
      .match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];

  const ppids = new Set();
  for (const pem of certs) {
    const der = Buffer.from(
      pem
        .split(/\r?\n/)
        .filter((line) => !line.includes("CERTIFICATE"))
        .join(""),
      "base64",
    );
    const at = der.indexOf(PPID_OID);
    if (at === -1) continue;
    const valueAt = at + PPID_OID.length;
    if (der[valueAt] !== 0x04) continue;
    const length = der[valueAt + 1];
    ppids.add(der.subarray(valueAt + 2, valueAt + 2 + length).toString("hex"));
  }

  if (ppids.size === 0) {
    failPpid("no PCK certificate with an SGX PPID extension");
  }
  if (ppids.size > 1) {
    failPpid(
      `the embedded PCK certificates disagree on the PPID (${[...ppids].join(", ")})`,
    );
  }
  const ppid = [...ppids][0];
  if (ppid.length !== PPID_LENGTH * 2) {
    failPpid(
      `the PPID extension held ${ppid.length / 2} bytes, expected ${PPID_LENGTH}`,
    );
  }
  return ppid;
}

/**
 * The PPID of the physical CPU package the KMS is running on — the same box the
 * agent will be deployed to. Read out of the attestation the KMS produced when
 * it bootstrapped, so no CVM has to be running.
 */
export function getPpidFromKmsQuote(sshHost) {
  const meta = getMeta(sshHost);
  const attestation = meta.bootstrap_info?.attestation;
  if (typeof attestation !== "string" || attestation.length === 0) {
    fail(
      `KMS.GetMeta on ${KMS_URL} carries no bootstrap attestation to read the PPID from. ` +
        `Put the PPID directly in approve_ppids.args instead.`,
    );
  }
  return extractPpidFromQuote(Buffer.from(attestation, "hex"));
}

/**
 * The app's env encryption public key, with the KMS signature over it verified
 * *and* the recovered signer pinned to the KMS's own k256 public key. Recovery
 * alone proves nothing — any well-formed signature recovers some key.
 */
export function getAppEnvEncryptPubKey(sshHost, appId) {
  const meta = getMeta(sshHost);
  if (typeof meta.k256_pubkey !== "string" || meta.k256_pubkey.length === 0) {
    fail(`KMS.GetMeta on ${KMS_URL} returned no k256_pubkey to pin the signer to`);
  }
  const expectedSigner = `0x${meta.k256_pubkey}`;

  const response = kmsRpc(sshHost, "GetAppEnvEncryptPubKey", { app_id: appId });
  if (typeof response?.public_key !== "string") {
    fail(`KMS.GetAppEnvEncryptPubKey returned no public_key for app ${appId}`);
  }
  const publicKey = Uint8Array.from(Buffer.from(response.public_key, "hex"));

  let signer = null;
  if (response.signature_v1 && response.timestamp !== undefined) {
    signer = verifyEnvEncryptPublicKey(
      publicKey,
      Uint8Array.from(Buffer.from(response.signature_v1, "hex")),
      appId,
      response.timestamp,
    );
  }
  if (!signer && response.signature) {
    signer = verifyEnvEncryptPublicKeyLegacy(
      publicKey,
      Uint8Array.from(Buffer.from(response.signature, "hex")),
      appId,
    );
  }

  if (!signer) {
    fail(
      `the KMS did not sign the env encryption key for app ${appId} with a verifiable signature`,
    );
  }
  if (signer !== expectedSigner) {
    fail(
      `the env encryption key for app ${appId} was signed by ${signer}, but this KMS's key is ${expectedSigner}`,
    );
  }

  return response.public_key;
}
