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
// internalGetAttestation validates collateral freshness (7-day max age,
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

// Build a minimal DER PCK CRL whose thisUpdate is `at`. Other fields use
// opaque DER placeholders — the freshness check only reads thisUpdate.
// Returns raw bytes, matching dcap-qvl's runtime shape (Array.from(Buffer)).
export function synthFreshPckCrlBytes(at: Date = new Date()): number[] {
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

// JSON blob shaped like tcb_info / qe_identity for freshness purposes
// (only issueDate is read by the freshness check).
export function freshTcbOrQeIdentityJson(at: Date = new Date()): string {
  return JSON.stringify({ issueDate: at.toISOString() });
}

// Mock dcap-qvl getCollateral return shape. Binary fields are `number[]`
// (dcap-qvl returns `Array.from(Buffer)`). Default tcb_info / qe_identity /
// pck_crl pass the freshness check at call time.
export function createMockDcapCollateral(overrides?: {
  pck_crl_issuer_chain?: string;
  root_ca_crl?: number[];
  pck_crl?: number[];
  tcb_info_issuer_chain?: string;
  tcb_info?: string;
  tcb_info_signature?: number[];
  qe_identity_issuer_chain?: string;
  qe_identity?: string;
  qe_identity_signature?: number[];
}) {
  return {
    pck_crl_issuer_chain: "",
    root_ca_crl: [],
    pck_crl: synthFreshPckCrlBytes(),
    tcb_info_issuer_chain: "",
    tcb_info: freshTcbOrQeIdentityJson(),
    tcb_info_signature: [],
    qe_identity_issuer_chain: "",
    qe_identity: freshTcbOrQeIdentityJson(),
    qe_identity_signature: [],
    pck_certificate_chain: null,
    ...overrides,
  };
}
