import { describe, it, expect, beforeEach, afterEach } from "vitest";
import asn1 from "asn1.js";
import {
  checkCollateralFreshness,
  FreshnessError,
  MAX_COLLATERAL_AGE_MS,
  FUTURE_TIMESTAMP_GRACE_MS,
} from "../../src/utils/collateral-freshness";
import type { Collateral } from "../../src/utils/tee";

// Minimal CRL encoder mirroring the decoder in collateral-freshness.ts.
// We only need enough to round-trip a controllable thisUpdate.
const Time = asn1.define("Time", function (this: any) {
  this.choice({
    utcTime: this.utctime(),
    generalTime: this.gentime(),
  });
});
const TBSCertList = asn1.define("TBSCertList", function (this: any) {
  this.seq().obj(
    this.key("version").int().optional(),
    this.key("signature").any(),
    this.key("issuer").any(),
    this.key("thisUpdate").use(Time),
  );
});
const CertificateList = asn1.define("CertificateList", function (this: any) {
  this.seq().obj(
    this.key("tbsCertList").use(TBSCertList),
    this.key("signatureAlgorithm").any(),
    this.key("signature").bitstr(),
  );
});

// Build a minimal valid-DER PCK CRL whose thisUpdate is `at`.
// Other fields use opaque placeholder bytes — the freshness check only
// reads thisUpdate, so the rest just needs to be valid DER any().
function synthCrl(at: Date): number[] {
  // Opaque DER stand-ins: NULL (05 00) is valid DER any().
  const NULL_DER = Buffer.from([0x05, 0x00]);
  const encoded = CertificateList.encode(
    {
      tbsCertList: {
        version: 1,
        signature: NULL_DER,
        issuer: NULL_DER,
        thisUpdate: { type: "generalTime", value: at },
      },
      signatureAlgorithm: NULL_DER,
      signature: { data: Buffer.from([0x00]), unused: 0 },
    },
    "der",
  );
  return Array.from(encoded as Buffer);
}

function jsonWithIssueDate(at: Date): string {
  return JSON.stringify({ issueDate: at.toISOString() });
}

function makeCollateral(
  tcbAt: Date,
  qeAt: Date,
  crlAt: Date,
): Collateral {
  return {
    pck_crl_issuer_chain: "",
    root_ca_crl: [],
    pck_crl: synthCrl(crlAt),
    tcb_info_issuer_chain: "",
    tcb_info: jsonWithIssueDate(tcbAt),
    tcb_info_signature: [],
    qe_identity_issuer_chain: "",
    qe_identity: jsonWithIssueDate(qeAt),
    qe_identity_signature: [],
  };
}

describe("checkCollateralFreshness", () => {
  const NOW = new Date("2026-05-22T12:00:00Z");

  beforeEach(() => {
    // Tests pass `now` explicitly — useFakeTimers isn't required, but
    // keeps any incidental `new Date()` deterministic.
  });
  afterEach(() => {});

  it("passes when all three timestamps are fresh", () => {
    const oneHourAgo = new Date(NOW.getTime() - 60 * 60 * 1000);
    const collateral = makeCollateral(oneHourAgo, oneHourAgo, oneHourAgo);
    expect(() => checkCollateralFreshness(collateral, NOW)).not.toThrow();
  });

  it("throws stale for tcb_info older than max age", () => {
    const fresh = new Date(NOW.getTime() - 60 * 60 * 1000);
    const stale = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000);
    const collateral = makeCollateral(stale, fresh, fresh);
    const settled = (() => {
      try {
        checkCollateralFreshness(collateral, NOW);
        return null;
      } catch (e) {
        return e as FreshnessError;
      }
    })();
    expect(settled).toBeInstanceOf(FreshnessError);
    expect(settled!.field).toBe("tcb_info");
    expect(settled!.kind).toBe("stale");
    expect(settled!.limitMs).toBe(MAX_COLLATERAL_AGE_MS);
  });

  it("throws stale for qe_identity older than max age", () => {
    const fresh = new Date(NOW.getTime() - 60 * 60 * 1000);
    const stale = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000);
    const collateral = makeCollateral(fresh, stale, fresh);
    const settled = (() => {
      try {
        checkCollateralFreshness(collateral, NOW);
        return null;
      } catch (e) {
        return e as FreshnessError;
      }
    })();
    expect(settled).toBeInstanceOf(FreshnessError);
    expect(settled!.field).toBe("qe_identity");
    expect(settled!.kind).toBe("stale");
  });

  it("throws stale for pck_crl thisUpdate older than max age", () => {
    const fresh = new Date(NOW.getTime() - 60 * 60 * 1000);
    const stale = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000);
    const collateral = makeCollateral(fresh, fresh, stale);
    const settled = (() => {
      try {
        checkCollateralFreshness(collateral, NOW);
        return null;
      } catch (e) {
        return e as FreshnessError;
      }
    })();
    expect(settled).toBeInstanceOf(FreshnessError);
    expect(settled!.field).toBe("pck_crl");
    expect(settled!.kind).toBe("stale");
  });

  it("throws future-timestamp when tcb_info is past the grace window", () => {
    const fresh = new Date(NOW.getTime() - 60 * 60 * 1000);
    const future = new Date(NOW.getTime() + 10 * 60 * 1000); // 10min > 5min grace
    const collateral = makeCollateral(future, fresh, fresh);
    const settled = (() => {
      try {
        checkCollateralFreshness(collateral, NOW);
        return null;
      } catch (e) {
        return e as FreshnessError;
      }
    })();
    expect(settled).toBeInstanceOf(FreshnessError);
    expect(settled!.field).toBe("tcb_info");
    expect(settled!.kind).toBe("future-timestamp");
    expect(settled!.limitMs).toBe(FUTURE_TIMESTAMP_GRACE_MS);
  });

  it("passes when a timestamp is in the future but within grace", () => {
    const fresh = new Date(NOW.getTime() - 60 * 60 * 1000);
    const slightlyFuture = new Date(NOW.getTime() + 60 * 1000); // 1min < 5min grace
    const collateral = makeCollateral(slightlyFuture, fresh, fresh);
    expect(() => checkCollateralFreshness(collateral, NOW)).not.toThrow();
  });

  it("passes at the exact max-age boundary", () => {
    const atBoundary = new Date(NOW.getTime() - MAX_COLLATERAL_AGE_MS);
    const collateral = makeCollateral(atBoundary, atBoundary, atBoundary);
    expect(() => checkCollateralFreshness(collateral, NOW)).not.toThrow();
  });

  it("throws json-parse on malformed tcb_info JSON", () => {
    const fresh = new Date(NOW.getTime() - 60 * 60 * 1000);
    const collateral = makeCollateral(fresh, fresh, fresh);
    collateral.tcb_info = "{not valid json";
    const settled = (() => {
      try {
        checkCollateralFreshness(collateral, NOW);
        return null;
      } catch (e) {
        return e as FreshnessError;
      }
    })();
    expect(settled).toBeInstanceOf(FreshnessError);
    expect(settled!.field).toBe("tcb_info");
    expect(settled!.kind).toBe("json-parse");
  });

  it("throws issue-date-rfc3339 on missing issueDate", () => {
    const fresh = new Date(NOW.getTime() - 60 * 60 * 1000);
    const collateral = makeCollateral(fresh, fresh, fresh);
    collateral.tcb_info = JSON.stringify({ otherField: "value" });
    const settled = (() => {
      try {
        checkCollateralFreshness(collateral, NOW);
        return null;
      } catch (e) {
        return e as FreshnessError;
      }
    })();
    expect(settled).toBeInstanceOf(FreshnessError);
    expect(settled!.field).toBe("tcb_info");
    expect(settled!.kind).toBe("issue-date-rfc3339");
  });

  it("throws crl-parse on malformed pck_crl DER", () => {
    const fresh = new Date(NOW.getTime() - 60 * 60 * 1000);
    const collateral = makeCollateral(fresh, fresh, fresh);
    collateral.pck_crl = [0xde, 0xad, 0xbe, 0xef];
    const settled = (() => {
      try {
        checkCollateralFreshness(collateral, NOW);
        return null;
      } catch (e) {
        return e as FreshnessError;
      }
    })();
    expect(settled).toBeInstanceOf(FreshnessError);
    expect(settled!.field).toBe("pck_crl");
    expect(settled!.kind).toBe("crl-parse");
  });

  it("throws crl-parse on empty pck_crl", () => {
    const fresh = new Date(NOW.getTime() - 60 * 60 * 1000);
    const collateral = makeCollateral(fresh, fresh, fresh);
    collateral.pck_crl = [];
    const settled = (() => {
      try {
        checkCollateralFreshness(collateral, NOW);
        return null;
      } catch (e) {
        return e as FreshnessError;
      }
    })();
    expect(settled).toBeInstanceOf(FreshnessError);
    expect(settled!.field).toBe("pck_crl");
    expect(settled!.kind).toBe("crl-parse");
  });
});
