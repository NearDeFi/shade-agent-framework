/**
 * Test image server that runs inside the TEE
 * Provides API endpoints for each test
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import dotenv from "dotenv";
import { ShadeClient } from "@neardefi/shade-agent-js";

// Import test handlers
import testWrongMeasurementsRtmr2 from "./tests/test-wrong-measurements-rtmr2";
import testWrongKeyProvider from "./tests/test-wrong-key-provider";
import testWrongAppCompose from "./tests/test-wrong-app-compose";
import testWrongPpid from "./tests/test-wrong-ppid";
import testDifferentAccountId from "./tests/test-different-account-id";
import testMeasurementsRemoved from "./tests/test-measurements-removed";
import testPpidRemoved from "./tests/test-ppid-removed";

// Load environment variables
dotenv.config();

const agentContractId = process.env.AGENT_CONTRACT_ID;
const sponsorAccountId = process.env.SPONSOR_ACCOUNT_ID;
const sponsorPrivateKey = process.env.SPONSOR_PRIVATE_KEY;

if (!agentContractId || !sponsorAccountId || !sponsorPrivateKey) {
  throw new Error(
    "Missing required environment variables AGENT_CONTRACT_ID, SPONSOR_ACCOUNT_ID, SPONSOR_PRIVATE_KEY"
  );
}

// Initialize agent
let agent: ShadeClient | null = null;

async function initializeAgent() {
  if (!agent) {
    agent = await ShadeClient.create({
      networkId: "testnet",
      agentContractId: agentContractId,
      sponsor: {
        accountId: sponsorAccountId!,
        privateKey: sponsorPrivateKey!,
      },
      derivationPath: sponsorPrivateKey, // Use same derivation path for consistent key generation
    });
  }
  return agent;
}

// Initialize app
const app = new Hono();

// Middleware
app.use(cors());

// Health check
app.get("/", (c) => c.json({ message: "Test image server is running" }));

// Test endpoints
app.post("/test/wrong-measurements-rtmr2", async (c) => {
  try {
    const agentInstance = await initializeAgent();
    const result = await testWrongMeasurementsRtmr2(agentInstance);
    return c.json(result);
  } catch (error: any) {
    return c.json(
      {
        success: false,
        error: error.message,
        stack: error.stack,
      },
      500
    );
  }
});

app.post("/test/wrong-key-provider", async (c) => {
  try {
    const agentInstance = await initializeAgent();
    const result = await testWrongKeyProvider(agentInstance);
    return c.json(result);
  } catch (error: any) {
    return c.json(
      {
        success: false,
        error: error.message,
        stack: error.stack,
      },
      500
    );
  }
});

app.post("/test/wrong-app-compose", async (c) => {
  try {
    const agentInstance = await initializeAgent();
    const result = await testWrongAppCompose(agentInstance);
    return c.json(result);
  } catch (error: any) {
    return c.json(
      {
        success: false,
        error: error.message,
        stack: error.stack,
      },
      500
    );
  }
});

app.post("/test/wrong-ppid", async (c) => {
  try {
    const agentInstance = await initializeAgent();
    const result = await testWrongPpid(agentInstance);
    return c.json(result);
  } catch (error: any) {
    return c.json(
      {
        success: false,
        error: error.message,
        stack: error.stack,
      },
      500
    );
  }
});

app.post("/test/different-account-id", async (c) => {
  try {
    const agentInstance = await initializeAgent();
    const result = await testDifferentAccountId(agentInstance);
    return c.json(result);
  } catch (error: any) {
    return c.json(
      {
        success: false,
        error: error.message,
        stack: error.stack,
      },
      500
    );
  }
});

app.post("/test/measurements-removed", async (c) => {
  try {
    const agentInstance = await initializeAgent();
    const result = await testMeasurementsRemoved(agentInstance);
    return c.json(result);
  } catch (error: any) {
    return c.json(
      {
        success: false,
        error: error.message,
        stack: error.stack,
      },
      500
    );
  }
});

app.post("/test/ppid-removed", async (c) => {
  try {
    const agentInstance = await initializeAgent();
    const result = await testPpidRemoved(agentInstance);
    return c.json(result);
  } catch (error: any) {
    return c.json(
      {
        success: false,
        error: error.message,
        stack: error.stack,
      },
      500
    );
  }
});

// Start server
const port = 3000;
console.log(`Test image server starting on port ${port}...`);
serve({ fetch: app.fetch, port });
