import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createDefaultProvider,
  createAccountObject,
  internalFundAgent,
  addKeysToAccount,
  removeKeysFromAccount,
} from '../../src/utils/near';
import { createMockProvider, createMockAccount, createMockSigner } from '../mocks';
import { JsonRpcProvider } from '@near-js/providers';
import { NEAR } from '@near-js/tokens';
import { generateTestKey, createMockBehavior, setSendTransactionBehavior } from '../test-utils';

vi.mock('@near-js/providers', () => ({
  JsonRpcProvider: vi.fn(),
}));

// Store Account method mocks globally so they can be overridden per test
const accountMockOverrides = {
  transfer: null as any,
  createSignedTransaction: null as any,
};

vi.mock('@near-js/accounts', () => {
  const MockAccount = vi.fn(function(this: any, accountId: string, provider: any, signer?: any) {
    const mockAccount = createMockAccount();
    this.accountId = accountId;
    this.provider = provider;
    this.signer = signer;
    // Use override if set, otherwise use default from mockAccount
    this.transfer = accountMockOverrides.transfer || mockAccount.transfer;
    this.createSignedTransaction = accountMockOverrides.createSignedTransaction || mockAccount.createSignedTransaction;
    return this;
  });
  return { Account: MockAccount };
});

describe('near utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountMockOverrides.transfer = null;
    accountMockOverrides.createSignedTransaction = null;
  });

  // Helper function for internalFundAgent tests
  function setupFundAgentMocks(transferBehavior: any) {
    const mockProvider = createMockProvider();
    const mockTransfer = createMockBehavior(transferBehavior);
    
    accountMockOverrides.transfer = mockTransfer;
        
    return { mockProvider, mockTransfer };
  }

  // Helper function for key operation tests (add/remove keys)
  function setupKeyOperationMocks() {
    const mockAccount = createMockAccount();
    const mockTx = {};

    
    (mockAccount.createSignedTransaction as ReturnType<typeof vi.fn>).mockResolvedValue(mockTx);
    
    return {
      mockAccount: mockAccount as any,
      mockTx,
      setSendTransactionBehavior: (behavior: any) => setSendTransactionBehavior(mockAccount, behavior)
    };
  }

  describe('createDefaultProvider', () => {
    it('should create provider for testnet', () => {
      const provider = createDefaultProvider('testnet');
      expect(JsonRpcProvider).toHaveBeenCalledWith(
        { url: 'https://test.rpc.fastnear.com' },
        { retries: 3, backoff: 2, wait: 1000 }
      );
      expect(provider).toBeDefined();
    });

    it('should create provider for mainnet', () => {
      const provider = createDefaultProvider('mainnet');
      expect(JsonRpcProvider).toHaveBeenCalledWith(
        { url: 'https://free.rpc.fastnear.com' },
        { retries: 3, backoff: 2, wait: 1000 }
      );
      expect(provider).toBeDefined();
    });
  });

  describe('createAccountObject', () => {
    it('should create Account without signer', () => {
      const mockProvider = createMockProvider();
      const account = createAccountObject('test.testnet', mockProvider);
      
      expect(account).toBeDefined();
      expect(account.accountId).toBe('test.testnet');
    });

    it('should create Account with signer', () => {
      const mockProvider = createMockProvider();
      const mockSigner = createMockSigner();
      const account = createAccountObject('test.testnet', mockProvider, mockSigner);
      
      expect(account).toBeDefined();
      expect(account.accountId).toBe('test.testnet');
    });
  });

  describe('internalFundAgent', () => {
    it('should successfully transfer NEAR on first attempt', async () => {
      const { mockProvider, mockTransfer } = setupFundAgentMocks({
        status: { SuccessValue: '' },
      });

      const sponsorKey = generateTestKey('sponsor-key');
      await internalFundAgent(
        'agent.testnet',
        'sponsor.testnet',
        sponsorKey,
        1.5,
        mockProvider
      );

      expect(mockTransfer).toHaveBeenCalledWith({
        token: NEAR,
        amount: NEAR.toUnits(1.5),
        receiverId: 'agent.testnet',
      });
    });

    it('should retry on failure and succeed on second attempt', async () => {
      const { mockProvider, mockTransfer } = setupFundAgentMocks(() => 
        vi.fn()
          .mockRejectedValueOnce(new Error('Network error'))
          .mockResolvedValueOnce({ status: { SuccessValue: '' } })
      );

      const sponsorKey = generateTestKey('sponsor-key');
      await internalFundAgent(
        'agent.testnet',
        'sponsor.testnet',
        sponsorKey,
        2.0,
        mockProvider
      );

      expect(mockTransfer).toHaveBeenCalledTimes(2);
    });

    it('should throw error after all retries exhausted', async () => {
      const { mockProvider, mockTransfer } = setupFundAgentMocks(() =>
        vi.fn().mockRejectedValue(new Error('Network error'))
      );

      const sponsorKey = generateTestKey('sponsor-key');
      await expect(
        internalFundAgent(
          'agent.testnet',
          'sponsor.testnet',
          sponsorKey,
          1.0,
          mockProvider
        )
      ).rejects.toThrow('Failed to fund agent account agent.testnet');

      expect(mockTransfer).toHaveBeenCalledTimes(3);
    });

    it('should handle non-Error exceptions after all retries exhausted', async () => {
      const { mockProvider, mockTransfer } = setupFundAgentMocks(() =>
        vi.fn().mockRejectedValue('String error')
      );

      const sponsorKey = generateTestKey('sponsor-key');
      await expect(
        internalFundAgent(
          'agent.testnet',
          'sponsor.testnet',
          sponsorKey,
          1.0,
          mockProvider
        )
      ).rejects.toThrow('Failed to fund agent account agent.testnet');

      expect(mockTransfer).toHaveBeenCalledTimes(3);
    });

    it('should throw error with error_type after retries when no error_message', async () => {
      const { mockProvider, mockTransfer } = setupFundAgentMocks({
        status: { Failure: { error_type: 'TypeOnlyError' } },
      });

      await expect(
        internalFundAgent(
          'agent.testnet',
          'sponsor.testnet',
          generateTestKey('sponsor-key'),
          1.0,
          mockProvider
        )
      ).rejects.toThrow('Transfer transaction failed: TypeOnlyError');

      expect(mockTransfer).toHaveBeenCalledTimes(3);
    });
  });

  describe('addKeysToAccount', () => {
    it('should successfully add keys on first attempt', async () => {
      const { mockAccount, mockTx, setSendTransactionBehavior } = setupKeyOperationMocks();
      
      setSendTransactionBehavior({
        status: { SuccessValue: '' },
      });

      const key1 = generateTestKey('key1');
      const key2 = generateTestKey('key2');
      await addKeysToAccount(mockAccount, [key1, key2]);

      expect(mockAccount.createSignedTransaction).toHaveBeenCalledWith(
        mockAccount.accountId,
        expect.arrayContaining([
          expect.any(Object), 
          expect.any(Object),
        ])
      );
      expect(mockAccount.provider.sendTransaction).toHaveBeenCalledWith(mockTx);
    });

    it('should retry on failure and succeed on second attempt', async () => {
      const { mockAccount, setSendTransactionBehavior } = setupKeyOperationMocks();
      
      setSendTransactionBehavior(() =>
        vi.fn()
          .mockRejectedValueOnce(new Error('Network error'))
          .mockResolvedValueOnce({ status: { SuccessValue: '' } })
      );

      const key1 = generateTestKey('key1');
      await addKeysToAccount(mockAccount, [key1]);

      expect(mockAccount.provider.sendTransaction).toHaveBeenCalledTimes(2);
    });

    it('should throw error after all retries exhausted', async () => {
      const { mockAccount, setSendTransactionBehavior } = setupKeyOperationMocks();
      
      setSendTransactionBehavior(() =>
        vi.fn().mockRejectedValue(new Error('Network error'))
      );

      await expect(
        addKeysToAccount(mockAccount, [generateTestKey('key1')])
      ).rejects.toThrow('Failed to add keys');

      expect(mockAccount.provider.sendTransaction).toHaveBeenCalledTimes(3);
    });

    it('should handle non-Error exceptions when adding keys', async () => {
      const { mockAccount, setSendTransactionBehavior } = setupKeyOperationMocks();
      
      setSendTransactionBehavior(() =>
        vi.fn().mockRejectedValue('String error')
      );

      await expect(
        addKeysToAccount(mockAccount, [generateTestKey('key1')])
      ).rejects.toThrow('Failed to add keys');

      expect(mockAccount.provider.sendTransaction).toHaveBeenCalledTimes(3);
    });

    it('should retry on transaction failure status', async () => {
      const { mockAccount, setSendTransactionBehavior } = setupKeyOperationMocks();
      
      setSendTransactionBehavior(() =>
        vi.fn()
          .mockResolvedValueOnce({
            status: { Failure: { error_message: 'Transaction failed' } },
          })
          .mockResolvedValueOnce({ status: { SuccessValue: '' } })
      );

      const key1 = generateTestKey('key1');
      await addKeysToAccount(mockAccount, [key1]);

      expect(mockAccount.provider.sendTransaction).toHaveBeenCalledTimes(2);
    });

    it('should throw error with error_type when add keys fails after retries', async () => {
      const { mockAccount, setSendTransactionBehavior } = setupKeyOperationMocks();
      
      setSendTransactionBehavior({
        status: { Failure: { error_type: 'TxnError' } },
      });

      await expect(
        addKeysToAccount(mockAccount, [generateTestKey('key1')])
      ).rejects.toThrow('Add keys transaction failed: TxnError');

      expect(mockAccount.provider.sendTransaction).toHaveBeenCalledTimes(3);
    });
  });

  describe('removeKeysFromAccount', () => {
    it('should successfully remove keys on first attempt', async () => {
      const { mockAccount, mockTx, setSendTransactionBehavior } = setupKeyOperationMocks();
      
      setSendTransactionBehavior({
        status: { SuccessValue: '' },
      });

      const key1 = generateTestKey('key1');
      const key2 = generateTestKey('key2');
      await removeKeysFromAccount(mockAccount, [key1, key2]);

      expect(mockAccount.createSignedTransaction).toHaveBeenCalledWith(
        mockAccount.accountId,
        expect.arrayContaining([
          expect.any(Object),
          expect.any(Object),
        ])
      );
      expect(mockAccount.provider.sendTransaction).toHaveBeenCalledWith(mockTx);
    });

    it('should retry on failure and succeed on second attempt', async () => {
      const { mockAccount, setSendTransactionBehavior } = setupKeyOperationMocks();
      
      setSendTransactionBehavior(() =>
        vi.fn()
          .mockRejectedValueOnce(new Error('Network error'))
          .mockResolvedValueOnce({ status: { SuccessValue: '' } })
      );

      const key1 = generateTestKey('key1');
      await removeKeysFromAccount(mockAccount, [key1]);

      expect(mockAccount.provider.sendTransaction).toHaveBeenCalledTimes(2);
    });

    it('should throw error after all retries exhausted', async () => {
      const { mockAccount, setSendTransactionBehavior } = setupKeyOperationMocks();
      
      setSendTransactionBehavior(() =>
        vi.fn().mockRejectedValue(new Error('Network error'))
      );

      await expect(
        removeKeysFromAccount(mockAccount, [generateTestKey('key1')])
      ).rejects.toThrow('Failed to remove keys');

      expect(mockAccount.provider.sendTransaction).toHaveBeenCalledTimes(3);
    });

    it('should handle non-Error exceptions when removing keys', async () => {
      const { mockAccount, setSendTransactionBehavior } = setupKeyOperationMocks();
      
      setSendTransactionBehavior(() =>
        vi.fn().mockRejectedValue('String error')
      );

      await expect(
        removeKeysFromAccount(mockAccount, [generateTestKey('key1')])
      ).rejects.toThrow('Failed to remove keys');

      expect(mockAccount.provider.sendTransaction).toHaveBeenCalledTimes(3);
    });

    it('should retry on transaction failure status', async () => {
      const { mockAccount, setSendTransactionBehavior } = setupKeyOperationMocks();
      
      setSendTransactionBehavior(() =>
        vi.fn()
          .mockResolvedValueOnce({
            status: { Failure: { error_type: 'ActionError' } },
          })
          .mockResolvedValueOnce({ status: { SuccessValue: '' } })
      );

      const key1 = generateTestKey('key1');
      await removeKeysFromAccount(mockAccount, [key1]);

      expect(mockAccount.provider.sendTransaction).toHaveBeenCalledTimes(2);
    });

    it('should throw error with error_type when remove keys fails after retries', async () => {
      const { mockAccount, setSendTransactionBehavior } = setupKeyOperationMocks();
      
      setSendTransactionBehavior({
        status: { Failure: { error_type: 'TxnError' } },
      });

      await expect(
        removeKeysFromAccount(mockAccount, [generateTestKey('key1')])
      ).rejects.toThrow('Remove keys transaction failed: TxnError');

      expect(mockAccount.provider.sendTransaction).toHaveBeenCalledTimes(3);
    });
  });
});
