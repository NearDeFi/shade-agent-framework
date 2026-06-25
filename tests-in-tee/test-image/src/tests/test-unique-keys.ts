/**
 * Test 9: Verify that two agent instances generate different private keys
 *
 * Keys MUST stay in the TEE, so all uniqueness validation happens here and only
 * counts + the unique flag are returned — never the keys themselves.
 */

import { ShadeClient } from "@neardefi/shade-agent-js";

export default async function testUniqueKeys(): Promise<{
  success: boolean;
  error?: string;
  agent1KeyCount?: number;
  agent2KeyCount?: number;
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

    // Get all private keys from both agents — these never leave this function;
    // only counts and the uniqueness verdict are returned.
    const agent1Keys = agent1.getPrivateKeys({ acknowledgeRisk: true });
    const agent2Keys = agent2.getPrivateKeys({ acknowledgeRisk: true });

    const agent1KeyCount = agent1Keys.length;
    const agent2KeyCount = agent2Keys.length;
    const counts = {
      agent1KeyCount,
      agent2KeyCount,
      agent1AccountId: agent1.accountId(),
      agent2AccountId: agent2.accountId(),
    };

    // Verify each agent has 3 keys
    if (agent1KeyCount !== 3) {
      return {
        success: false,
        error: `Agent 1 should have 3 keys, got ${agent1KeyCount}`,
        ...counts,
      };
    }

    if (agent2KeyCount !== 3) {
      return {
        success: false,
        error: `Agent 2 should have 3 keys, got ${agent2KeyCount}`,
        ...counts,
      };
    }

    // Combine all keys into a single array
    const allKeys = [...agent1Keys, ...agent2Keys];

    if (allKeys.length !== 6) {
      return {
        success: false,
        error: `Should have 6 total keys, got ${allKeys.length}`,
        ...counts,
      };
    }

    // Check that all keys are unique using Set
    const uniqueKeys = new Set(allKeys);
    const allKeysUnique = uniqueKeys.size === 6;

    if (!allKeysUnique) {
      return {
        success: false,
        error: `Found duplicate keys. Expected 6 unique keys, got ${uniqueKeys.size}`,
        allKeysUnique: false,
        ...counts,
      };
    }

    // Cross-check: verify no key from agent1 matches any key from agent2
    for (const key1 of agent1Keys) {
      for (const key2 of agent2Keys) {
        if (key1 === key2) {
          return {
            success: false,
            error: "Found a matching key between agent1 and agent2",
            allKeysUnique: false,
            ...counts,
          };
        }
      }
    }

    // Also check for duplicates within each agent's keys
    if (new Set(agent1Keys).size !== 3) {
      return {
        success: false,
        error: "Agent 1 has duplicate keys",
        allKeysUnique: false,
        ...counts,
      };
    }

    if (new Set(agent2Keys).size !== 3) {
      return {
        success: false,
        error: "Agent 2 has duplicate keys",
        allKeysUnique: false,
        ...counts,
      };
    }

    return {
      success: true,
      allKeysUnique: true,
      ...counts,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || String(error),
    };
  }
}
