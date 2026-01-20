import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generateAgent,
  manageKeySetup,
  getAgentSigner,
  ensureKeysSetup,
} from '../../src/utils/agent';
import { createMockAccount, createMockProvider } from '../mocks';
import { createMockDstackClient } from '../mocks/tee-mocks';
import { addKeysToAccount, removeKeysFromAccount } from '../../src/utils/near';
import { generateTestKey, createMockAccountWithKeys } from '../test-utils';
import { Account } from '@near-js/accounts';

vi.mock('../../src/utils/near', () => ({
  addKeysToAccount: vi.fn(),
  removeKeysFromAccount: vi.fn(),
}));

// Store mock account globally so Account class can access it
let globalMockAccount: any = null;

// Mock Account class - return our mock account instance
vi.mock('@near-js/accounts', () => {
  const MockAccount = vi.fn(function(this: any, accountId: string, provider: any, signer?: any) {
    const mockAccount = globalMockAccount || createMockAccount();
    this.accountId = accountId;
    this.provider = provider;
    this.signer = signer;
    this.getAccessKeyList = mockAccount.getAccessKeyList;
    this.getBalance = mockAccount.getBalance;
    this.callFunction = mockAccount.callFunction;
    this.transfer = mockAccount.transfer;
    this.createSignedTransaction = mockAccount.createSignedTransaction;
    return this;
  });
  return { Account: MockAccount };
});

beforeEach(() => {
  vi.clearAllMocks();
  globalMockAccount = null;
});

describe('agent utils', () => {
  describe('generateAgent', () => {
    it('should generate agent with derivation path when no TEE', async () => {
      const derivationPath = 'test-derivation-path';
      
      const result = await generateAgent(undefined, derivationPath);
      
      expect(result).toHaveProperty('accountId');
      expect(result.accountId).toMatch(/^[0-9a-f]{64}$/); // 32 bytes = 64 hex chars
      expect(result.agentPrivateKey).toMatch(/^ed25519:/);
      expect(result).toHaveProperty('derivedWithTEE', false);
    });

    it('should generate agent with random hash when no TEE and no derivation path', async () => {
      const result = await generateAgent(undefined, undefined);
      
      expect(result).toHaveProperty('accountId');
      expect(result.accountId).toMatch(/^[0-9a-f]{64}$/); // 32 bytes = 64 hex chars
      expect(result.agentPrivateKey).toMatch(/^ed25519:/);
      expect(result).toHaveProperty('derivedWithTEE', false);
    });

    it('should generate agent with TEE when dstackClient is provided', async () => {
      const dstackClient = createMockDstackClient();
      
      const result = await generateAgent(dstackClient, undefined);
      
      expect(result).toHaveProperty('accountId');
      expect(result.accountId).toMatch(/^[0-9a-f]{64}$/); // 32 bytes = 64 hex chars
      expect(result.agentPrivateKey).toMatch(/^ed25519:/);
      expect(result).toHaveProperty('derivedWithTEE', true);
      expect(dstackClient.getKey).toHaveBeenCalled();
    });
  });

  describe('manageKeySetup', () => {
    it('should add keys when account has fewer keys than needed', async () => {
      const mockAccount = createMockAccountWithKeys([{ public_key: 'key1' }]);
      
      const result = await manageKeySetup(mockAccount as any, 2, undefined, undefined);
      
      expect(addKeysToAccount).toHaveBeenCalledWith(mockAccount, expect.arrayContaining([
        expect.any(String),
        expect.any(String),
      ]));
      expect(result.keysToSave).toHaveLength(2);
      expect(result.allDerivedWithTEE).toBe(false);
    });

    it('should remove keys when account has more keys than needed', async () => {
      const mockAccount = createMockAccountWithKeys([
        { public_key: 'key1' },
        { public_key: 'key2' },
        { public_key: 'key3' },
      ]);
      
      const result = await manageKeySetup(mockAccount as any, 1, undefined, undefined);
      
      expect(removeKeysFromAccount).toHaveBeenCalledWith(mockAccount, expect.arrayContaining([
        expect.any(String),
      ]));
      expect(result.keysToSave).toHaveLength(1);
    });

    it('should not add or remove keys when account has correct number of keys', async () => {
      const mockAccount = createMockAccountWithKeys([
        { public_key: 'key1' },
        { public_key: 'key2' },
      ]);
      
      const result = await manageKeySetup(mockAccount as any, 1, undefined, undefined);
      
      expect(addKeysToAccount).not.toHaveBeenCalled();
      expect(removeKeysFromAccount).not.toHaveBeenCalled();
      expect(result.keysToSave).toHaveLength(1);
    });

    it('should use TEE when dstackClient is provided', async () => {
      const dstackClient = createMockDstackClient();
      const mockAccount = createMockAccountWithKeys([{ public_key: 'key1' }]);
      
      const result = await manageKeySetup(mockAccount as any, 1, dstackClient, undefined);
      
      expect(result.allDerivedWithTEE).toBe(true);
      expect(dstackClient.getKey).toHaveBeenCalled();
    });

    it('should generate unique keys when adding multiple keys with TEE', async () => {
      const dstackClient = createMockDstackClient();
      const mockAccount = createMockAccountWithKeys([{ public_key: 'key1' }]);
      
      await manageKeySetup(mockAccount as any, 3, dstackClient, undefined);
      expect(addKeysToAccount).toHaveBeenCalled();
      const keys = vi.mocked(addKeysToAccount).mock.calls[0][1] as string[];
      
      // Verify all 3 keys are different
      expect(keys).toHaveLength(3);
      expect(keys[0]).not.toBe(keys[1]);
      expect(keys[0]).not.toBe(keys[2]);
      expect(keys[1]).not.toBe(keys[2]);
    });

    it('should generate unique keys when adding multiple keys with derivation path', async () => {
      const mockAccount = createMockAccountWithKeys([{ public_key: 'key1' }]);
      const derivationPath = 'test-path';
      
      await manageKeySetup(mockAccount as any, 3, undefined, derivationPath);
      expect(addKeysToAccount).toHaveBeenCalled();
      const keys = vi.mocked(addKeysToAccount).mock.calls[0][1] as string[];
      
      // Verify all 3 keys are different (each uses different derivation path: path-1, path-2, path-3)
      expect(keys).toHaveLength(3);
      expect(keys[0]).not.toBe(keys[1]);
      expect(keys[0]).not.toBe(keys[2]);
      expect(keys[1]).not.toBe(keys[2]);
    });

    it('should generate unique keys when adding multiple keys without derivation path', async () => {
      const mockAccount = createMockAccountWithKeys([{ public_key: 'key1' }]);
      
      await manageKeySetup(mockAccount as any, 3, undefined, undefined);
      expect(addKeysToAccount).toHaveBeenCalled();
      const keys = vi.mocked(addKeysToAccount).mock.calls[0][1] as string[];
      
      // Verify all 3 keys are different
      expect(keys).toHaveLength(3);
      expect(keys[0]).not.toBe(keys[1]);
      expect(keys[0]).not.toBe(keys[2]);
      expect(keys[1]).not.toBe(keys[2]);
    });
  });

  describe('key determinism across different agents', () => {
    it('should generate different first keys and additional keys for two different agents with TEE', async () => {
      const dstackClient1 = createMockDstackClient();
      const dstackClient2 = createMockDstackClient();
      
      // Test first keys (from generateAgent)
      const agent1 = await generateAgent(dstackClient1, undefined);
      const agent2 = await generateAgent(dstackClient2, undefined);
      
      expect(agent1.accountId).not.toBe(agent2.accountId);
      expect(agent1.agentPrivateKey).not.toBe(agent2.agentPrivateKey);
      
      // Test additional keys (from manageKeySetup)
      const mockAccount1 = createMockAccountWithKeys([{ public_key: 'key1' }]);
      const mockAccount2 = createMockAccountWithKeys([{ public_key: 'key1' }]);
      
      await manageKeySetup(mockAccount1 as any, 2, dstackClient1, undefined);
      const additionalKeys1 = vi.mocked(addKeysToAccount).mock.calls[0][1] as string[];
      
      vi.clearAllMocks();
      
      await manageKeySetup(mockAccount2 as any, 2, dstackClient2, undefined);
      const additionalKeys2 = vi.mocked(addKeysToAccount).mock.calls[0][1] as string[];
      
      // Verify different agents with TEE produce different additional keys
      expect(additionalKeys1).not.toEqual(additionalKeys2);
      expect(additionalKeys1).toHaveLength(2);
      expect(additionalKeys2).toHaveLength(2);
    });

    it('should generate different first keys and additional keys for two different agents without TEE and without derivation path', async () => {
      // Test first keys (from generateAgent)
      const agent1 = await generateAgent(undefined, undefined);
      const agent2 = await generateAgent(undefined, undefined);
      
      expect(agent1.accountId).not.toBe(agent2.accountId);
      expect(agent1.agentPrivateKey).not.toBe(agent2.agentPrivateKey);
      
      // Test additional keys (from manageKeySetup)
      const mockAccount1 = createMockAccountWithKeys([{ public_key: 'key1' }]);
      const mockAccount2 = createMockAccountWithKeys([{ public_key: 'key1' }]);
      
      await manageKeySetup(mockAccount1 as any, 2, undefined, undefined);
      const additionalKeys1 = vi.mocked(addKeysToAccount).mock.calls[0][1] as string[];
      
      vi.clearAllMocks();
      
      await manageKeySetup(mockAccount2 as any, 2, undefined, undefined);
      const additionalKeys2 = vi.mocked(addKeysToAccount).mock.calls[0][1] as string[];
      
      // Verify different agents without derivation path produce different additional keys
      expect(additionalKeys1).not.toEqual(additionalKeys2);
      expect(additionalKeys1).toHaveLength(2);
      expect(additionalKeys2).toHaveLength(2);
    });

    it('should generate identical first keys and additional keys for two different agents with same derivation path', async () => {
      const derivationPath = 'deterministic-path';
      
      // Test first keys (from generateAgent)
      const agent1 = await generateAgent(undefined, derivationPath);
      const agent2 = await generateAgent(undefined, derivationPath);
      
      expect(agent1.accountId).toBe(agent2.accountId);
      expect(agent1.agentPrivateKey).toBe(agent2.agentPrivateKey);
      
      // Test additional keys (from manageKeySetup)
      const mockAccount1 = createMockAccountWithKeys([{ public_key: 'key1' }]);
      const mockAccount2 = createMockAccountWithKeys([{ public_key: 'key1' }]);
      
      await manageKeySetup(mockAccount1 as any, 2, undefined, derivationPath);
      const additionalKeys1 = vi.mocked(addKeysToAccount).mock.calls[0][1] as string[];
      
      vi.clearAllMocks();
      
      await manageKeySetup(mockAccount2 as any, 2, undefined, derivationPath);
      const additionalKeys2 = vi.mocked(addKeysToAccount).mock.calls[0][1] as string[];
      
      // Verify same derivation path produces identical additional keys across different agents
      expect(additionalKeys1).toEqual(additionalKeys2);
      expect(additionalKeys1).toHaveLength(2);
      expect(additionalKeys2).toHaveLength(2);
    });

    it('should generate different first keys and additional keys for two different agents with different derivation paths', async () => {
      const derivationPath1 = 'path-one';
      const derivationPath2 = 'path-two';
      
      // Test first keys (from generateAgent)
      const agent1 = await generateAgent(undefined, derivationPath1);
      const agent2 = await generateAgent(undefined, derivationPath2);
      
      expect(agent1.accountId).not.toBe(agent2.accountId);
      expect(agent1.agentPrivateKey).not.toBe(agent2.agentPrivateKey);
      
      // Test additional keys (from manageKeySetup)
      const mockAccount1 = createMockAccountWithKeys([{ public_key: 'key1' }]);
      const mockAccount2 = createMockAccountWithKeys([{ public_key: 'key1' }]);
      
      await manageKeySetup(mockAccount1 as any, 2, undefined, derivationPath1);
      const additionalKeys1 = vi.mocked(addKeysToAccount).mock.calls[0][1] as string[];
      
      vi.clearAllMocks();
      
      await manageKeySetup(mockAccount2 as any, 2, undefined, derivationPath2);
      const additionalKeys2 = vi.mocked(addKeysToAccount).mock.calls[0][1] as string[];
      
      // Verify different derivation paths produce different additional keys across different agents
      expect(additionalKeys1).not.toEqual(additionalKeys2);
      expect(additionalKeys1).toHaveLength(2);
      expect(additionalKeys2).toHaveLength(2);
    });
  });

  describe('getAgentSigner', () => {
    it('should throw error when no keys available', () => {
      expect(() => {
        getAgentSigner([], 0);
      }).toThrow('No agent keys available');
    });

    it('should return same key when only one key available', () => {
      const keys = [generateTestKey('key1')];
      const result1 = getAgentSigner(keys, 0);
      const result2 = getAgentSigner(keys, 0);
      
      expect(result1.keyIndex).toBe(0);
      expect(result2.keyIndex).toBe(0);
      expect(result1.signer).toBeDefined();
      expect(result2.signer).toBeDefined();
    });

    it('should rotate through keys correctly', () => {
      const keys = [
        generateTestKey('key1'),
        generateTestKey('key2'),
        generateTestKey('key3'),
      ];
      
      const result1 = getAgentSigner(keys, 0);
      expect(result1.keyIndex).toBe(1);
      
      const result2 = getAgentSigner(keys, result1.keyIndex);
      expect(result2.keyIndex).toBe(2);
      
      const result3 = getAgentSigner(keys, result2.keyIndex);
      expect(result3.keyIndex).toBe(0); // Wraps around
    });
  });

  describe('ensureKeysSetup', () => {
    it('should return early when keysChecked is true', async () => {
      // Generate a valid test key
      const testKey = generateTestKey('test-key');
      
      const result = await ensureKeysSetup(
        'agent.testnet',
        [testKey],
        createMockProvider(),
        1,
        undefined,
        undefined,
        false,
        true // keysChecked = true
      );
      
      expect(result).toEqual({ keysToAdd: [], wasChecked: true });
      
      // Verify no side effects occurred (early return)
      expect(Account).not.toHaveBeenCalled();
      expect(addKeysToAccount).not.toHaveBeenCalled();
    });

    it('should setup keys when keysChecked is false', async () => {
      const mockProvider = createMockProvider();
      const mockAccount = createMockAccountWithKeys([{ public_key: 'key1' }]);
      
      // Generate a valid test key
      const testKey = generateTestKey('test-key');
      
      // Set global mock account so Account constructor uses it
      globalMockAccount = mockAccount;
      
      const result = await ensureKeysSetup(
        'agent.testnet',
        [testKey],
        mockProvider,
        2,
        undefined,
        undefined,
        false,
        false
      );
      
      expect(result.wasChecked).toBe(true);
      expect(result.keysToAdd).toHaveLength(1);
      expect(Account).toHaveBeenCalledWith('agent.testnet', mockProvider, expect.anything());
    });

    it('should throw error when first key was TEE but additional keys are not', async () => {
      const mockProvider = createMockProvider();
      const mockAccount = createMockAccountWithKeys([{ public_key: 'key1' }]);
      
      // Generate a valid test key
      const testKey = generateTestKey('test-key');
      
      // Set global mock account so Account constructor uses it
      globalMockAccount = mockAccount;
      
      await expect(
        ensureKeysSetup(
          'agent.testnet',
          [testKey],
          mockProvider,
          2,
          undefined, // No TEE client, so additional keys won't use TEE
          undefined,
          true, // First key was derived with TEE
          false
        )
      ).rejects.toThrow('First key was derived with TEE but additional keys were not');
    });

    it('should not throw error when both first and additional keys use TEE', async () => {
      const dstackClient = createMockDstackClient();
      const mockProvider = createMockProvider();
      const mockAccount = createMockAccountWithKeys([{ public_key: 'key1' }]);
      
      // Generate a valid test key
      const testKey = generateTestKey('test-key');
      
      // Set global mock account so Account constructor uses it
      globalMockAccount = mockAccount;
      
      const result = await ensureKeysSetup(
        'agent.testnet',
        [testKey],
        mockProvider,
        2,
        dstackClient,
        undefined,
        true,
        false
      );
      
      expect(result.wasChecked).toBe(true);
      expect(dstackClient.getKey).toHaveBeenCalled();
    });

    it('should not throw error when no keys use TEE', async () => {
      const mockProvider = createMockProvider();
      const mockAccount = createMockAccountWithKeys([{ public_key: 'key1' }]);
      
      // Generate a valid test key
      const testKey = generateTestKey('test-key');
      
      // Set global mock account so Account constructor uses it
      globalMockAccount = mockAccount;
      
      const result = await ensureKeysSetup(
        'agent.testnet',
        [testKey],
        mockProvider,
        2,
        undefined,
        undefined,
        false,
        false
      );
      
      expect(result.wasChecked).toBe(true);
    });
  });
});
