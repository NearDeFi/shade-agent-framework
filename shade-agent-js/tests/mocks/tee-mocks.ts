import { vi } from "vitest";
import asn1 from "asn1.js";
import type { DstackClient, TcbInfoV05x } from "@phala/dstack-sdk";

export const createMockDstackClient = (): DstackClient => {
  return {
    info: vi.fn().mockResolvedValue({
      tcb_info: createMockDstackTcbInfo(),
    }),
    getKey: vi.fn().mockResolvedValue({
      key: new Uint8Array(32).fill(1),
    }),
    getQuote: vi.fn().mockResolvedValue({
      quote: "0".repeat(200),
    }),
  } as unknown as DstackClient;
};

// Creates a mock DstackTcbInfo (TcbInfoV05x) for testing
// Allows overriding specific fields while providing defaults for the rest
export function createMockDstackTcbInfo(
  overrides?: Partial<TcbInfoV05x>,
): TcbInfoV05x {
  return {
    mrtd: "",
    rtmr0: "",
    rtmr1: "",
    rtmr2: "",
    rtmr3: "",
    mr_aggregated: "",
    os_image_hash: "",
    compose_hash: "",
    device_id: "",
    app_compose: "",
    event_log: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Freshness-passing fixture helpers
//
// internalGetAttestation now validates collateral freshness (7-day max age,
// 5-min future grace) on tcb_info.issueDate, qe_identity.issueDate, and PCK
// CRL thisUpdate. The mock collateral defaults below produce values that
// pass that check against the real wall clock at call time.
// ---------------------------------------------------------------------------

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

// Build a minimal DER PCK CRL whose thisUpdate is `at`. Hex-encoded since
// callers receive collateral fields as hex strings from the verify endpoint.
export function synthFreshPckCrlHex(at: Date = new Date()): string {
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
  return (encoded as Buffer).toString("hex");
}

// JSON blob shaped like tcb_info / qe_identity for freshness purposes
// (only issueDate is read by the freshness check).
export function freshTcbOrQeIdentityJson(at: Date = new Date()): string {
  return JSON.stringify({ issueDate: at.toISOString() });
}

// Creates a mock quote collateral (RawCollateral) for testing
// Allows overriding specific fields while providing defaults for the rest.
// Default tcb_info, qe_identity, and pck_crl pass the freshness check.
export function createMockQuoteCollateral(overrides?: {
  pck_crl_issuer_chain?: string;
  root_ca_crl?: string;
  pck_crl?: string;
  tcb_info_issuer_chain?: string;
  tcb_info?: string;
  tcb_info_signature?: string;
  qe_identity_issuer_chain?: string;
  qe_identity?: string;
  qe_identity_signature?: string;
}) {
  return {
    pck_crl_issuer_chain: "",
    root_ca_crl: "",
    pck_crl: synthFreshPckCrlHex(),
    tcb_info_issuer_chain: "",
    tcb_info: freshTcbOrQeIdentityJson(),
    tcb_info_signature: "",
    qe_identity_issuer_chain: "",
    qe_identity: freshTcbOrQeIdentityJson(),
    qe_identity_signature: "",
    ...overrides,
  };
}

// Creates a mock attestation response (QuoteCollateralResponse) for testing
export function createMockAttestationResponse(overrides?: {
  checksum?: string;
  quote_collateral?: ReturnType<typeof createMockQuoteCollateral>;
}) {
  return {
    checksum: overrides?.checksum ?? "mock-checksum-123",
    quote_collateral:
      overrides?.quote_collateral ?? createMockQuoteCollateral(),
  };
}
