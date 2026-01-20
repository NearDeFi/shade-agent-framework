import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getDstackClient, internalGetAttestation } from '../../src/utils/tee';
import { createMockDstackClient, mockAttestationResponse } from '../mocks/tee-mocks';

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
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const result = await getDstackClient();
      expect(result).toBeUndefined();
      expect(existsSync).toHaveBeenCalledWith('/var/run/dstack.sock');
    });

    it('should return undefined when DstackClient constructor throws error', async () => {
      const { existsSync } = await import('fs');
      const { DstackClient } = await import('@phala/dstack-sdk');
      
      vi.mocked(existsSync).mockReturnValue(true);
      vi.spyOn(DstackClient.prototype, 'constructor' as any).mockImplementation(function() {
        throw new Error('Connection failed');
      });

      const result = await getDstackClient();
      expect(result).toBeUndefined();
    });

    it('should return undefined when client.info() throws error', async () => {
      const { existsSync } = await import('fs');
      const { DstackClient } = await import('@phala/dstack-sdk');
      
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
      const { existsSync } = await import('fs');
      const { DstackClient } = await import('@phala/dstack-sdk');
      
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
      
      expect(result).toEqual({
        quote_hex: 'not-in-a-tee',
        collateral: 'not-in-a-tee',
        checksum: 'not-in-a-tee',
        tcb_info: 'not-in-a-tee',
      });
    });

    it('should return dummy attestation when keysDerivedWithTEE is false', async () => {
      const mockClient = createMockDstackClient();
      const result = await internalGetAttestation(mockClient, 'agent.testnet', false);
      
      expect(result).toEqual({
        quote_hex: 'not-in-a-tee',
        collateral: 'not-in-a-tee',
        checksum: 'not-in-a-tee',
        tcb_info: 'not-in-a-tee',
      });
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
      
      // Verify the report data contains the agent account ID
      const getQuoteCall = vi.mocked(mockClient.getQuote).mock.calls[0];
      const reportData = getQuoteCall[0] as Buffer;
      expect(reportData.toString('utf-8')).toBe(agentAccountId);

      // Verify fetch was called with correct parameters
      expect(mockFetch).toHaveBeenCalledWith(
        'https://proof.t16z.com/api/upload',
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

      expect(result.quote_hex).toBeDefined();
      expect(result.quote_hex).not.toMatch(/^0x/); // Should have 0x prefix removed
      expect(result.collateral).toBe(JSON.stringify(mockAttestationResponse.quote_collateral));
      expect(result.checksum).toBe(mockAttestationResponse.checksum);
      expect(result.tcb_info).toBeDefined();
    });

    it('should remove 0x prefix from quote', async () => {
      const mockClient = createMockDstackClient();
      (mockClient.getQuote as ReturnType<typeof vi.fn>).mockResolvedValue({
        quote: '0x1234567890abcdef',
      });

      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue(mockAttestationResponse),
      };
      mockFetch.mockResolvedValue(mockResponse);

      const result = await internalGetAttestation(mockClient, 'agent.testnet', true);

      expect(result.quote_hex).toBe('1234567890abcdef');
    });

    it('should handle quote without 0x prefix', async () => {
      const mockClient = createMockDstackClient();
      (mockClient.getQuote as ReturnType<typeof vi.fn>).mockResolvedValue({
        quote: '1234567890abcdef',
      });

      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue(mockAttestationResponse),
      };
      mockFetch.mockResolvedValue(mockResponse);

      const result = await internalGetAttestation(mockClient, 'agent.testnet', true);

      expect(result.quote_hex).toBe('1234567890abcdef');
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
      const mockResponse = {
        ok: false,
        status: 500,
      };
      mockFetch.mockResolvedValue(mockResponse);

      await expect(
        internalGetAttestation(mockClient, 'agent.testnet', true)
      ).rejects.toThrow('Failed to get quote collateral: HTTP 500');
    });

    it('should handle 404 response', async () => {
      const mockClient = createMockDstackClient();
      const mockResponse = {
        ok: false,
        status: 404,
      };
      mockFetch.mockResolvedValue(mockResponse);

      await expect(
        internalGetAttestation(mockClient, 'agent.testnet', true)
      ).rejects.toThrow('Failed to get quote collateral: HTTP 404');
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

    it('should stringify tcb_info correctly', async () => {
      const mockClient = createMockDstackClient();
      const tcbInfo = { version: '2.0', platform: 'test-platform' };
      (mockClient.info as ReturnType<typeof vi.fn>).mockResolvedValue({
        tcb_info: tcbInfo,
      });

      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue(mockAttestationResponse),
      };
      mockFetch.mockResolvedValue(mockResponse);

      const result = await internalGetAttestation(mockClient, 'agent.testnet', true);

      expect(result.tcb_info).toBe(JSON.stringify(tcbInfo));
    });

    it('should stringify quote_collateral correctly', async () => {
      const mockClient = createMockDstackClient();
      const quoteCollateral = { version: '1.0', platform: 'test' };
      const customResponse = {
        checksum: 'custom-checksum',
        quote_collateral: quoteCollateral,
      };

      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue(customResponse),
      };
      mockFetch.mockResolvedValue(mockResponse);

      const result = await internalGetAttestation(mockClient, 'agent.testnet', true);

      expect(result.collateral).toBe(JSON.stringify(quoteCollateral));
      expect(result.checksum).toBe('custom-checksum');
    });
  });
});
