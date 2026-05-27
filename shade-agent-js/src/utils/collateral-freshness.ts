import asn1 from "asn1.js";
import type { Collateral } from "./tee";

// Reject collateral whose Intel-signed timestamps are older than this.
// Intel re-signs the three pieces we check (tcb_info.issueDate,
// qe_identity.issueDate, PCK CRL thisUpdate) on a ~weekly cadence inside
// a 30-day validity window, so 7 days is stricter than Intel's window
export const MAX_COLLATERAL_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Tolerate small forward clock skew on the issuer/PCCS side: a timestamp
// up to this far in the future is treated as "now" rather than rejected.
export const FUTURE_TIMESTAMP_GRACE_MS = 5 * 60 * 1000;

export type FreshnessField = "tcb_info" | "qe_identity" | "pck_crl";
export type FreshnessKind =
  | "stale"
  | "future-timestamp"
  | "json-parse"
  | "issue-date-rfc3339"
  | "crl-parse";

export class FreshnessError extends Error {
  readonly field: FreshnessField;
  readonly kind: FreshnessKind;
  readonly issuedAt?: Date;
  readonly elapsedMs?: number;
  readonly limitMs?: number;

  constructor(
    message: string,
    details: {
      field: FreshnessField;
      kind: FreshnessKind;
      issuedAt?: Date;
      elapsedMs?: number;
      limitMs?: number;
    },
  ) {
    super(message);
    this.name = "FreshnessError";
    this.field = details.field;
    this.kind = details.kind;
    this.issuedAt = details.issuedAt;
    this.elapsedMs = details.elapsedMs;
    this.limitMs = details.limitMs;
  }
}

// asn1.js TIME = CHOICE { UTCTime, GeneralizedTime }. Both decoders run
// through asn1.js's _decodeTime, which returns `Date.UTC(...)` — a
// Unix-ms `number`. The CHOICE wrapper yields
// `{ type: 'utcTime' | 'generalTime', value: number }`.
const Time = asn1.define("Time", function (this: any) {
  this.choice({
    utcTime: this.utctime(),
    generalTime: this.gentime(),
  });
});

// Minimal TBSCertList — we only care about thisUpdate. All other fields
// are decoded as opaque so the schema accepts any valid X.509 v2 CRL.
const TBSCertList = asn1.define("TBSCertList", function (this: any) {
  this.seq().obj(
    this.key("version").int().optional(),
    this.key("signature").any(),
    this.key("issuer").any(),
    this.key("thisUpdate").use(Time),
    // nextUpdate / revokedCertificates / crlExtensions ignored
  );
});

const CertificateList = asn1.define("CertificateList", function (this: any) {
  this.seq().obj(
    this.key("tbsCertList").use(TBSCertList),
    this.key("signatureAlgorithm").any(),
    this.key("signature").bitstr(),
  );
});

// Parse `issueDate` out of a TCB-Info-shaped or QE-Identity-shaped JSON
// blob. The blob carries a lot more fields than we care about; we only
// read the top-level `issueDate` (Intel publishes this on every signed
// piece on the same ~weekly cadence).
function parseIssueDateFromJson(
  field: FreshnessField,
  raw: string,
): Date {
  let parsed: { issueDate?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FreshnessError(
      `Failed to JSON.parse ${field} for freshness check`,
      { field, kind: "json-parse" },
    );
  }
  if (typeof parsed.issueDate !== "string") {
    throw new FreshnessError(
      `Missing or non-string issueDate in ${field}`,
      { field, kind: "issue-date-rfc3339" },
    );
  }
  const date = new Date(parsed.issueDate);
  if (Number.isNaN(date.getTime())) {
    throw new FreshnessError(
      `Unparseable issueDate in ${field}`,
      { field, kind: "issue-date-rfc3339" },
    );
  }
  return date;
}

// Parse the PCK CRL DER bytes and pull out thisUpdate. PCK CRL is a
// standard X.509 v2 CertificateList; we mirror the schema dcap-qvl uses
// in @phala/dcap-qvl/src/utils.js (TBSCertList SEQUENCE { version?,
// signature, issuer, thisUpdate, ... }), narrowed to just thisUpdate.
function parsePckCrlThisUpdate(pckCrlBytes: number[]): Date {
  if (!pckCrlBytes || pckCrlBytes.length === 0) {
    throw new FreshnessError("PCK CRL is empty", {
      field: "pck_crl",
      kind: "crl-parse",
    });
  }
  let decoded: { tbsCertList?: { thisUpdate?: { value?: number } } };
  try {
    decoded = CertificateList.decode(Buffer.from(pckCrlBytes), "der");
  } catch {
    throw new FreshnessError("Failed to decode PCK CRL as DER X.509 v2 CRL", {
      field: "pck_crl",
      kind: "crl-parse",
    });
  }
  // asn1.js decodes UTCTime / GeneralizedTime into a Unix-ms `number` on
  // the `value` field of the CHOICE wrapper.
  const thisUpdateMs = decoded?.tbsCertList?.thisUpdate?.value;
  if (typeof thisUpdateMs !== "number" || Number.isNaN(thisUpdateMs)) {
    throw new FreshnessError("PCK CRL thisUpdate is missing or unparseable", {
      field: "pck_crl",
      kind: "crl-parse",
    });
  }
  return new Date(thisUpdateMs);
}

// Throws FreshnessError if `issuedAt` is older than MAX_COLLATERAL_AGE_MS
// or further than FUTURE_TIMESTAMP_GRACE_MS in the future relative to
// `now`. Strict `>` so the exact boundary passes.
function checkWithinWindow(
  field: FreshnessField,
  issuedAt: Date,
  now: Date,
): void {
  const elapsedMs = now.getTime() - issuedAt.getTime();
  if (elapsedMs > MAX_COLLATERAL_AGE_MS) {
    throw new FreshnessError(
      `${field} is stale: ${elapsedMs}ms old, limit ${MAX_COLLATERAL_AGE_MS}ms`,
      {
        field,
        kind: "stale",
        issuedAt,
        elapsedMs,
        limitMs: MAX_COLLATERAL_AGE_MS,
      },
    );
  }
  if (-elapsedMs > FUTURE_TIMESTAMP_GRACE_MS) {
    throw new FreshnessError(
      `${field} is timestamped ${-elapsedMs}ms in the future, grace ${FUTURE_TIMESTAMP_GRACE_MS}ms`,
      {
        field,
        kind: "future-timestamp",
        issuedAt,
        elapsedMs,
        limitMs: FUTURE_TIMESTAMP_GRACE_MS,
      },
    );
  }
}

// Reject collateral bundles whose Intel-signed timestamps are stale or
// implausibly in the future. Checks tcb_info.issueDate,
// qe_identity.issueDate, and PCK CRL thisUpdate in that order; the first
// failure throws.
// Every throw site below constructs a FreshnessError directly with a
// constant-shape message, so there is no untrusted-input echo that would
// require sanitisation here. Callers (internalGetAttestation in tee.ts)
// already wrap their own outer catch in `toThrowable`.
export function checkCollateralFreshness(
  collateral: Collateral,
  now: Date,
): void {
  const tcbIssuedAt = parseIssueDateFromJson("tcb_info", collateral.tcb_info);
  checkWithinWindow("tcb_info", tcbIssuedAt, now);

  const qeIssuedAt = parseIssueDateFromJson(
    "qe_identity",
    collateral.qe_identity,
  );
  checkWithinWindow("qe_identity", qeIssuedAt, now);

  const crlIssuedAt = parsePckCrlThisUpdate(collateral.pck_crl);
  checkWithinWindow("pck_crl", crlIssuedAt, now);
}
