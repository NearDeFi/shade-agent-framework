/**
 * Test 9: Verify that two agent instances generate different private keys
 *
 * Keys MUST stay in the TEE, so all uniqueness validation happens here and only
 * counts + the unique flag are returned — never the keys themselves.
 */

import { ShadeClient } from "@neardefi/shade-agent-js";

const KEYS_PER_AGENT = 50;

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
    // Create first agent instance
    const agent1 = await ShadeClient.create({
      networkId: "testnet",
      agentContractId: process.env.AGENT_CONTRACT_ID,
      sponsor: {
        accountId: process.env.SPONSOR_ACCOUNT_ID!,
        privateKey: process.env.SPONSOR_PRIVATE_KEY!,
      },
      derivationPath: process.env.SPONSOR_PRIVATE_KEY,
      numKeys: KEYS_PER_AGENT,
    });

    // Fund first agent
    await agent1.fund(0.5);

    // Register first agent (this will add keys via ensureKeysSetup)
    await agent1.register();

    // Create second agent instance
    const agent2 = await ShadeClient.create({
      networkId: "testnet",
      agentContractId: process.env.AGENT_CONTRACT_ID,
      sponsor: {
        accountId: process.env.SPONSOR_ACCOUNT_ID!,
        privateKey: process.env.SPONSOR_PRIVATE_KEY!,
      },
      derivationPath: process.env.SPONSOR_PRIVATE_KEY,
      numKeys: KEYS_PER_AGENT,
    });

    // Fund second agent
    await agent2.fund(0.5);

    // Register second agent (this will add keys via ensureKeysSetup)
    await agent2.register();

    // Get all private keys from both agents — these never leave this function;
    // only counts and the uniqueness verdict are returned.
    const agent1Keys = agent1.getPrivateKeys({ acknowledgeRisk: true });
    const agent2Keys = agent2.getPrivateKeys({ acknowledgeRisk: true });

    // One Set over every key catches any duplicate — within either agent or
    // across them. The script asserts the per-agent counts separately.
    const allKeys = [...agent1Keys, ...agent2Keys];
    const allKeysUnique = new Set(allKeys).size === allKeys.length;
    const agent1KeyCount = agent1Keys.length;
    const agent2KeyCount = agent2Keys.length;

    return {
      success:
        allKeysUnique &&
        agent1KeyCount === KEYS_PER_AGENT &&
        agent2KeyCount === KEYS_PER_AGENT,
      allKeysUnique,
      agent1KeyCount,
      agent2KeyCount,
      agent1AccountId: agent1.accountId(),
      agent2AccountId: agent2.accountId(),
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message || String(error),
    };
  }
}
