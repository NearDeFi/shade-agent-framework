import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'fs';
import { DstackClient } from '@phala/dstack-sdk';
import { getDstackClient, internalGetAttestation } from '../../src/utils/tee';
import {
  createMockDstackClient,
  mockAttestationResponse,
  createMockDstackTcbInfo,
  createMockQuoteCollateral,
  createMockAttestationResponse,
} from '../mocks/tee-mocks';
import { getFakeAttestation } from '../../src/utils/attestation-transform';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

// Mock DstackClient SDK
vi.mock('@phala/dstack-sdk', () => ({
  DstackClient: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe('tee utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getDstackClient', () => {
    it('should return undefined when socket does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = await getDstackClient();
      expect(result).toBeUndefined();
      expect(existsSync).toHaveBeenCalledWith('/var/run/dstack.sock');
    });

    it('should return undefined when DstackClient constructor throws error', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.spyOn(DstackClient.prototype, 'constructor' as any).mockImplementation(function() {
        throw new Error('Connection failed');
      });

      const result = await getDstackClient();
      expect(result).toBeUndefined();
    });

    it('should return undefined when client.info() throws error', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const mockClient = createMockDstackClient();
      (mockClient.info as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Connection failed'));
      vi.mocked(DstackClient).mockImplementation(function() {
        return mockClient;
      } as any);

      const result = await getDstackClient();
      expect(result).toBeUndefined();
      expect(mockClient.info).toHaveBeenCalled();
    });

    it('should return client when socket exists and client works', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const mockClient = createMockDstackClient();
      vi.mocked(DstackClient).mockImplementation(function() {
        return mockClient;
      } as any);

      const result = await getDstackClient();
      expect(result).toBe(mockClient);
      expect(mockClient.info).toHaveBeenCalled();
    });
  });

  describe('internalGetAttestation', () => {
    it('should return dummy attestation when no dstackClient', async () => {
      const result = await internalGetAttestation(undefined, 'agent.testnet', false);
      
      expect(result).toEqual(getFakeAttestation());
    });

    it('should return dummy attestation when keysDerivedWithTEE is false', async () => {
      const mockClient = createMockDstackClient();
      const result = await internalGetAttestation(mockClient, 'agent.testnet', false);
      
      expect(result).toEqual(getFakeAttestation());
      expect(mockClient.info).not.toHaveBeenCalled();
      expect(mockClient.getQuote).not.toHaveBeenCalled();
    });

    it('should get real attestation when in TEE', async () => {
      const mockClient = createMockDstackClient();
      const agentAccountId = 'agent.testnet';
      
      // Setup fetch mock
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue(mockAttestationResponse),
      };
      mockFetch.mockResolvedValue(mockResponse);

      const result = await internalGetAttestation(mockClient, agentAccountId, true);

      expect(mockClient.info).toHaveBeenCalled();
      expect(mockClient.getQuote).toHaveBeenCalledWith(
        expect.any(Buffer)
      );
      
      // Verify the report data contains the agent account ID as bytes padded to 64 bytes
      const getQuoteCall = vi.mocked(mockClient.getQuote).mock.calls[0];
      const reportData = getQuoteCall[0] as Buffer;
      expect(reportData.length).toBe(64);
      const accountIdBytes = Buffer.from(agentAccountId, 'hex');
      expect(reportData.subarray(0, accountIdBytes.length)).toEqual(accountIdBytes);
      // Remaining bytes should be zero
      expect(reportData.subarray(accountIdBytes.length)).toEqual(Buffer.alloc(64 - accountIdBytes.length));

      // Verify fetch was called with correct parameters
      expect(mockFetch).toHaveBeenCalledWith(
        'https://cloud-api.phala.network/api/v1/attestations/verify',
        expect.objectContaining({
          method: 'POST',
          body: expect.any(FormData),
          signal: expect.any(AbortSignal),
        })
      );

      // Verify FormData contains the quote_hex
      const fetchCall = mockFetch.mock.calls[0];
      const formData = fetchCall[1].body as FormData;
      const formDataEntries = Array.from(formData.entries());
      expect(formDataEntries.length).toBe(1);
      expect(formDataEntries[0][0]).toBe('hex');

      expect(result.quote).toBeDefined();
      expect(Array.isArray(result.quote)).toBe(true);
      expect(result.collateral).toBeDefined();
      expect(result.tcb_info).toBeDefined();
    });

    it('should handle fetch errors', async () => {
      const mockClient = createMockDstackClient();
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(
        internalGetAttestation(mockClient, 'agent.testnet', true)
      ).rejects.toThrow('Failed to get quote collateral: Network error');
    });

    it('should handle non-Error exceptions in fetch', async () => {
      const mockClient = createMockDstackClient();
      mockFetch.mockRejectedValue('String error');

      await expect(
        internalGetAttestation(mockClient, 'agent.testnet', true)
      ).rejects.toThrow('Failed to get quote collateral: String error');
    });

    it('should handle non-ok fetch responses', async () => {
      const mockClient = createMockDstackClient();
      const statusCodes = [404, 500, 503];
      
      for (const status of statusCodes) {
        const mockResponse = {
          ok: false,
          status,
        };
        mockFetch.mockResolvedValue(mockResponse);

        await expect(
          internalGetAttestation(mockClient, 'agent.testnet', true)
        ).rejects.toThrow(`Failed to get quote collateral: HTTP ${status}`);
        
        mockFetch.mockClear();
      }
    });

    it('should set up timeout for fetch request', async () => {
      const mockClient = createMockDstackClient();
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
      
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue(mockAttestationResponse),
      };
      mockFetch.mockResolvedValue(mockResponse);

      await internalGetAttestation(mockClient, 'agent.testnet', true);

      // Verify setTimeout was called with 30000ms (30 seconds)
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30000);
      setTimeoutSpy.mockRestore();
    });

    it('should execute timeout callback and abort fetch when timeout fires', async () => {
      const mockClient = createMockDstackClient();
      let capturedAbortSignal: AbortSignal | null = null;
      let abortController: AbortController | null = null;
      let abortReject: ((error: Error) => void) | null = null;
      
      // Spy on AbortController to capture the instance
      const originalAbortController = global.AbortController;
      global.AbortController = class extends originalAbortController {
        constructor() {
          super();
          abortController = this;
        }
      } as any;
      
      // Mock fetch to capture the abort signal and reject when aborted
      mockFetch.mockImplementation((url, options) => {
        capturedAbortSignal = options?.signal as AbortSignal;
        // When signal is aborted, reject with AbortError
        return new Promise((_, reject) => {
          abortReject = reject;
          if (capturedAbortSignal) {
            // Check if already aborted (synchronous check)
            if (capturedAbortSignal.aborted) {
              const error = new Error('The operation was aborted');
              error.name = 'AbortError';
              reject(error);
            } else {
              // Listen for abort event
              capturedAbortSignal.addEventListener('abort', () => {
                const error = new Error('The operation was aborted');
                error.name = 'AbortError';
                reject(error);
              }, { once: true });
            }
          }
        });
      });

      vi.useFakeTimers();
      const promise = internalGetAttestation(mockClient, 'agent.testnet', true);
      
      // Add a catch handler immediately to prevent unhandled rejection
      let rejectionError: Error | null = null;
      promise.catch((error: unknown) => {
        rejectionError = error as Error;
      });
      
      // Give a small delay to ensure fetch is called and signal is captured
      await vi.advanceTimersByTimeAsync(100);
      
      // Verify we have the abort signal before proceeding
      expect(capturedAbortSignal).toBeDefined();
      
      // Now fast-forward time to trigger the timeout callback (30 seconds)
      // This will execute the arrow function: () => controller.abort()
      vi.advanceTimersByTime(30000);
      
      // Process all pending timers to ensure the abort callback executes
      await vi.runOnlyPendingTimersAsync();
      
      // Verify the abort signal was triggered by the timeout callback
      expect((capturedAbortSignal as unknown as AbortSignal).aborted).toBe(true);
      
      // Wait a bit more to ensure the abort event listener fires and rejects
      await vi.advanceTimersByTimeAsync(10);
      await vi.runOnlyPendingTimersAsync();
      
      // Verify the promise rejected
      await expect(promise).rejects.toThrow('Failed to get quote collateral');
      
      // Also verify we caught the error in our handler
      expect(rejectionError).toBeInstanceOf(Error);
      expect(rejectionError).not.toBeNull();
      const error = rejectionError as unknown as Error;
      expect(error.message).toContain('Failed to get quote collateral');
      expect(error.message).toContain('The operation was aborted');
      
      // Restore original AbortController
      global.AbortController = originalAbortController;
      vi.useRealTimers();
    });

    it('should clear timeout when fetch succeeds', async () => {
      const mockClient = createMockDstackClient();
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue(mockAttestationResponse),
      };
      mockFetch.mockResolvedValue(mockResponse);

      await internalGetAttestation(mockClient, 'agent.testnet', true);

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });

    it('should transform tcb_info correctly', async () => {
      const mockClient = createMockDstackClient();
      const dstackTcbInfo = createMockDstackTcbInfo({
        mrtd: 'mrtd_val',
        rtmr0: 'rtmr0_val',
        rtmr1: 'rtmr1_val',
        rtmr2: 'rtmr2_val',
        rtmr3: 'rtmr3_val',
        mr_aggregated: 'mr_agg',
        os_image_hash: 'os_hash',
        compose_hash: 'compose_hash',
        device_id: 'device_id',
        app_compose: 'app_compose',
      });
      (mockClient.info as ReturnType<typeof vi.fn>).mockResolvedValue({
        tcb_info: dstackTcbInfo,
      });

      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue(mockAttestationResponse),
      };
      mockFetch.mockResolvedValue(mockResponse);

      const result = await internalGetAttestation(mockClient, 'agent.testnet', true);

      expect(result.tcb_info).toEqual({
        mrtd: 'mrtd_val',
        rtmr0: 'rtmr0_val',
        rtmr1: 'rtmr1_val',
        rtmr2: 'rtmr2_val',
        rtmr3: 'rtmr3_val',
        os_image_hash: 'os_hash',
        compose_hash: 'compose_hash',
        device_id: 'device_id',
        app_compose: 'app_compose',
        event_log: [],
      });
    });

    it('should transform quote_collateral correctly', async () => {
      const mockClient = createMockDstackClient();
      const quoteCollateral = createMockQuoteCollateral({
        tcb_info_issuer_chain: 'chain1',
        tcb_info: 'tcb_info_json',
        tcb_info_signature: 'deadbeef',
        qe_identity_issuer_chain: 'chain2',
        qe_identity: 'qe_identity_json',
        qe_identity_signature: 'cafebabe',
        pck_crl_issuer_chain: 'chain3',
        root_ca_crl: '12345678',
        pck_crl: '87654321',
      });
      const customResponse = createMockAttestationResponse({
        checksum: 'custom-checksum',
        quote_collateral: quoteCollateral,
      });

      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue(customResponse),
      };
      mockFetch.mockResolvedValue(mockResponse);

      const result = await internalGetAttestation(mockClient, 'agent.testnet', true);

      expect(result.collateral).toEqual({
        pck_crl_issuer_chain: 'chain3',
        root_ca_crl: [18, 52, 86, 120], // hex decoded
        pck_crl: [135, 101, 67, 33], // hex decoded
        tcb_info_issuer_chain: 'chain1',
        tcb_info: 'tcb_info_json',
        tcb_info_signature: [222, 173, 190, 239], // hex decoded
        qe_identity_issuer_chain: 'chain2',
        qe_identity: 'qe_identity_json',
        qe_identity_signature: [202, 254, 186, 190], // hex decoded
      });
    });
  });
});
