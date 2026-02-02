import { generateSeedPhrase } from 'near-seed-phrase';
import { createHash } from 'crypto';
import { vi } from 'vitest';
import { createMockAccount } from './mocks';
import type { DstackAttestation } from '../src/utils/tee';

// Generates a valid ed25519 test key from a seed string
export function generateTestKey(seed: string): string {
  const hash = createHash('sha256').update(Buffer.from(seed)).digest();
  const seedInfo = generateSeedPhrase(hash);
  return seedInfo.secretKey;
}

// Helper to create a mock behavior function that can handle both function and value inputs
export function createMockBehavior(behavior: any): ReturnType<typeof vi.fn> {
  if (typeof behavior === 'function') {
    return behavior();
  }
  return vi.fn().mockResolvedValue(behavior);
}

// Helper to set mock behavior on a provider's sendTransaction method
export function setSendTransactionBehavior(
  mockAccount: any,
  behavior: any
): void {
  if (typeof behavior === 'function') {
    const mockFn = behavior();
    (mockAccount.provider.sendTransaction as ReturnType<typeof vi.fn>).mockImplementation(mockFn);
  } else {
    (mockAccount.provider.sendTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(behavior);
  }
}

// Helper to create a mock account with a specific access key list
export function createMockAccountWithKeys(keys: Array<{ public_key: string }>) {
  const mockAccount = createMockAccount();
  (mockAccount.getAccessKeyList as ReturnType<typeof vi.fn>).mockResolvedValue({ keys });
  return mockAccount;
}

// Creates a mock DstackAttestation for testing
// Allows overriding specific fields while providing defaults for the rest
export function createMockAttestation(
  overrides?: Partial<DstackAttestation>
): DstackAttestation {
  return {
    quote: overrides?.quote ?? [],
    collateral: {
      pck_crl_issuer_chain: '',
      root_ca_crl: [],
      pck_crl: [],
      tcb_info_issuer_chain: '',
      tcb_info: '',
      tcb_info_signature: [],
      qe_identity_issuer_chain: '',
      qe_identity: '',
      qe_identity_signature: [],
      ...overrides?.collateral,
    },
    tcb_info: {
      mrtd: '',
      rtmr0: '',
      rtmr1: '',
      rtmr2: '',
      rtmr3: '',
      os_image_hash: '',
      compose_hash: '',
      device_id: '',
      app_compose: '',
      event_log: [],
      ...overrides?.tcb_info,
    },
  };
}
