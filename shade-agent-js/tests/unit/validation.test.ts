import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateShadeConfig } from '../../src/utils/validation';
import type { ShadeConfig } from '../../src/api';
import { createMockProvider } from '../mocks';
import { createDefaultProvider } from '../../src/utils/near';

vi.mock('../../src/utils/near', () => ({
  createDefaultProvider: vi.fn(),
}));

describe('validateShadeConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the mock to return a provider that matches the networkId
    vi.mocked(createDefaultProvider).mockImplementation((networkId: string) => 
      createMockProvider(networkId) as any
    );
  });

  it('should set default networkId to testnet when not provided', async () => {
    const config: ShadeConfig = {};
    await validateShadeConfig(config);
    expect(config.networkId).toBe('testnet');
  });

  it('should accept testnet as networkId', async () => {
    const config: ShadeConfig = { networkId: 'testnet' };
    await validateShadeConfig(config);
    expect(config.networkId).toBe('testnet');
  });

  it('should accept mainnet as networkId', async () => {
    const config: ShadeConfig = { networkId: 'mainnet' };
    await validateShadeConfig(config);
    expect(config.networkId).toBe('mainnet');
  });

  it('should throw error when networkId does not match RPC provider network', async () => {
    const config: ShadeConfig = { networkId: 'testnet' };
    
    // Mock provider to return a different network ID
    vi.mocked(createDefaultProvider).mockReturnValue(createMockProvider('mainnet') as any);
    
    await expect(validateShadeConfig(config)).rejects.toThrow(
      'Network ID mismatch: config.networkId is "testnet" but RPC provider is connected to "mainnet"'
    );
  });

  it('should throw error for invalid networkId', async () => {
    const config: ShadeConfig = { networkId: 'invalid' as any };
    await expect(validateShadeConfig(config)).rejects.toThrow(
      'networkId must be either \'testnet\' or \'mainnet\''
    );
  });

  it('should set default numKeys to 1 when not provided', async () => {
    const config: ShadeConfig = { networkId: 'testnet' };
    await validateShadeConfig(config);
    expect(config.numKeys).toBe(1);
  });

  it('should accept valid numKeys between 1 and 100', async () => {
    const config: ShadeConfig = { networkId: 'testnet', numKeys: 5 };
    await validateShadeConfig(config);
    expect(config.numKeys).toBe(5);
  });

  it('should throw error for numKeys less than 1', async () => {
    const config: ShadeConfig = { networkId: 'testnet', numKeys: 0 };
    await expect(validateShadeConfig(config)).rejects.toThrow(
      'numKeys must be an integer between 1 and 100'
    );
  });

  it('should throw error for numKeys greater than 100', async () => {
    const config: ShadeConfig = { networkId: 'testnet', numKeys: 101 };
    await expect(validateShadeConfig(config)).rejects.toThrow(
      'numKeys must be an integer between 1 and 100'
    );
  });

  it('should throw error for non-integer numKeys', async () => {
    const config: ShadeConfig = { networkId: 'testnet', numKeys: 5.5 as any };
    await expect(validateShadeConfig(config)).rejects.toThrow(
      'numKeys must be an integer between 1 and 100'
    );
  });

  it('should validate sponsor accountId when sponsor is provided', async () => {
    const config: ShadeConfig = {
      networkId: 'testnet',
      sponsor: {
        accountId: '',
        privateKey: 'ed25519:test',
      },
    };
    await expect(validateShadeConfig(config)).rejects.toThrow(
      'sponsor.accountId is required when sponsor is provided'
    );
  });

  it('should validate sponsor privateKey when sponsor is provided', async () => {
    const config: ShadeConfig = {
      networkId: 'testnet',
      sponsor: {
        accountId: 'sponsor.testnet',
        privateKey: '',
      },
    };
    await expect(validateShadeConfig(config)).rejects.toThrow(
      'sponsor.privateKey is required when sponsor is provided'
    );
  });

  it('should accept valid sponsor configuration', async () => {
    const config: ShadeConfig = {
      networkId: 'testnet',
      sponsor: {
        accountId: 'sponsor.testnet',
        privateKey: 'ed25519:test',
      },
    };
    await validateShadeConfig(config);
    expect(config.sponsor?.accountId).toBe('sponsor.testnet');
  });

  it('should use provided RPC provider without creating default', async () => {
    const mockProvider = createMockProvider('testnet');
    const config: ShadeConfig = {
      networkId: 'testnet',
      rpc: mockProvider,
    };
    
    await validateShadeConfig(config);
    
    // Verify createDefaultProvider was NOT called
    expect(createDefaultProvider).not.toHaveBeenCalled();
    expect(config.rpc).toBeDefined();
  });
});
