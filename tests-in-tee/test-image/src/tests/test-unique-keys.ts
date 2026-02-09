/**
 * Test 9: Verify that two agent instances generate different private keys
 *
 * In TEE: Create two agents, register, get keys, verify uniqueness (MUST stay in TEE:
 * private keys cannot leave the TEE, so validation cannot move to script)
 * In script: Verify allKeysUnique, key counts
 */

import { ShadeClient } from "@neardefi/shade-agent-js";

export default async function testUniqueKeys(): Promise<{
  success: boolean;
  error?: string;
  agent1Keys?: string[];
  agent2Keys?: string[];
  allKeysUnique?: boolean;
  agent1AccountId?: string;
  agent2AccountId?: string;
}> {
  try {
    // Create first agent instance with numKeys=3
    const agent1 = await ShadeClient.create({
      networkId: "testnet",
      agentContractId: process.env.AGENT_CONTRACT_ID,
      sponsor: {
        accountId: process.env.SPONSOR_ACCOUNT_ID!,
        privateKey: process.env.SPONSOR_PRIVATE_KEY!,
      },
      derivationPath: process.env.SPONSOR_PRIVATE_KEY,
      numKeys: 3,
    });

    // Fund first agent
    await agent1.fund(0.3);

    // Register first agent (this will add keys via ensureKeysSetup)
    await agent1.register();

    // Create second agent instance with numKeys=3
    const agent2 = await ShadeClient.create({
      networkId: "testnet",
      agentContractId: process.env.AGENT_CONTRACT_ID,
      sponsor: {
        accountId: process.env.SPONSOR_ACCOUNT_ID!,
        privateKey: process.env.SPONSOR_PRIVATE_KEY!,
      },
      derivationPath: process.env.SPONSOR_PRIVATE_KEY,
      numKeys: 3,
    });

    // Fund second agent
    await agent2.fund(0.3);

    // Register second agent (this will add keys via ensureKeysSetup)
    await agent2.register();

    // Get all private keys from both agents
    const agent1Keys = agent1.getPrivateKeys(true);
    const agent2Keys = agent2.getPrivateKeys(true);

    const agent1AccountId = agent1.accountId();
    const agent2AccountId = agent2.accountId();

    // Verify each agent has 3 keys
    if (agent1Keys.length !== 3) {
      return {
        success: false,
        error: `Agent 1 should have 3 keys, got ${agent1Keys.length}`,
        agent1Keys,
        agent2Keys,
        agent1AccountId,
        agent2AccountId,
      };
    }

    if (agent2Keys.length !== 3) {
      return {
        success: false,
        error: `Agent 2 should have 3 keys, got ${agent2Keys.length}`,
        agent1Keys,
        agent2Keys,
        agent1AccountId,
        agent2AccountId,
      };
    }

    // Combine all keys into a single array
    const allKeys = [...agent1Keys, ...agent2Keys];

    if (allKeys.length !== 6) {
      return {
        success: false,
        error: `Should have 6 total keys, got ${allKeys.length}`,
        agent1Keys,
        agent2Keys,
        agent1AccountId,
        agent2AccountId,
      };
    }

    // Check that all keys are unique using Set
    const uniqueKeys = new Set(allKeys);
    const allKeysUnique = uniqueKeys.size === 6;

    if (!allKeysUnique) {
      return {
        success: false,
        error: `Found duplicate keys. Expected 6 unique keys, got ${uniqueKeys.size}`,
        agent1Keys,
        agent2Keys,
        allKeysUnique: false,
        agent1AccountId,
        agent2AccountId,
      };
    }

    // Cross-check: verify no key from agent1 matches any key from agent2
    for (const key1 of agent1Keys) {
      for (const key2 of agent2Keys) {
        if (key1 === key2) {
          return {
            success: false,
            error: `Found matching key between agent1 and agent2: ${key1.substring(0, 20)}...`,
            agent1Keys,
            agent2Keys,
            allKeysUnique: false,
            agent1AccountId,
            agent2AccountId,
          };
        }
      }
    }

    // Also check for duplicates within each agent's keys
    const agent1Unique = new Set(agent1Keys);
    if (agent1Unique.size !== 3) {
      return {
        success: false,
        error: `Agent 1 has duplicate keys. Expected 3 unique keys, got ${agent1Unique.size}`,
        agent1Keys,
        agent2Keys,
        allKeysUnique: false,
        agent1AccountId,
        agent2AccountId,
      };
    }

    const agent2Unique = new Set(agent2Keys);
    if (agent2Unique.size !== 3) {
      return {
        success: false,
        error: `Agent 2 has duplicate keys. Expected 3 unique keys, got ${agent2Unique.size}`,
        agent1Keys,
        agent2Keys,
        allKeysUnique: false,
        agent1AccountId,
        agent2AccountId,
      };
    }

    return {
      success: true,
      agent1Keys,
      agent2Keys,
      allKeysUnique: true,
      agent1AccountId,
      agent2AccountId,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || String(error),
    };
  }
}
