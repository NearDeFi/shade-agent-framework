import { vi } from 'vitest';
import type { DstackClient, TcbInfoV05x } from '@phala/dstack-sdk';

export const createMockDstackClient = (): DstackClient => {
  return {
    info: vi.fn().mockResolvedValue({
      tcb_info: createMockDstackTcbInfo(),
    }),
    getKey: vi.fn().mockResolvedValue({
      key: new Uint8Array(32).fill(1),
    }),
    getQuote: vi.fn().mockResolvedValue({
      quote: '0'.repeat(200),
    }),
  } as unknown as DstackClient;
};

// Creates a mock DstackTcbInfo (TcbInfoV05x) for testing
// Allows overriding specific fields while providing defaults for the rest
export function createMockDstackTcbInfo(
  overrides?: Partial<TcbInfoV05x>
): TcbInfoV05x {
  return {
    mrtd: '',
    rtmr0: '',
    rtmr1: '',
    rtmr2: '',
    rtmr3: '',
    mr_aggregated: '',
    os_image_hash: '',
    compose_hash: '',
    device_id: '',
    app_compose: '',
    event_log: [],
    ...overrides,
  };
}

// Creates a mock quote collateral (RawCollateral) for testing
// Allows overriding specific fields while providing defaults for the rest
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
    pck_crl_issuer_chain: '',
    root_ca_crl: '',
    pck_crl: '',
    tcb_info_issuer_chain: '',
    tcb_info: '',
    tcb_info_signature: '',
    qe_identity_issuer_chain: '',
    qe_identity: '',
    qe_identity_signature: '',
    ...overrides,
  };
}

// Creates a mock attestation response (QuoteCollateralResponse) for testing
export function createMockAttestationResponse(overrides?: {
  checksum?: string;
  quote_collateral?: ReturnType<typeof createMockQuoteCollateral>;
}) {
  return {
    checksum: overrides?.checksum ?? 'mock-checksum-123',
    quote_collateral: overrides?.quote_collateral ?? createMockQuoteCollateral(),
  };
}

// Default mock attestation response for backward compatibility
export const mockAttestationResponse = createMockAttestationResponse();
