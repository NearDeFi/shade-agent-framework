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
import testSuccessfulRegistration from "./tests/test-successful-registration";

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

// Create a new agent instance for each test (for test independence)
async function createAgent() {
  const newAgent = await ShadeClient.create({
    networkId: "testnet",
    agentContractId: agentContractId,
    sponsor: {
      accountId: sponsorAccountId!,
      privateKey: sponsorPrivateKey!,
    },
    derivationPath: sponsorPrivateKey, // Use same derivation path for consistent key generation
  });
  // Fund the agent
  await newAgent.fund(0.3);
  return newAgent;
}

// Storage for registered agents (keyed by test name)
const registeredAgents = new Map<string, ShadeClient>();

// Initialize app
const app = new Hono();

// Middleware
app.use(cors());

// Health check
app.get("/", (c) => c.json({ message: "Test image server is running" }));

// Endpoint to register and store an agent for later use
app.post("/test/register-agent/:testName", async (c) => {
  try {
    const testName = c.req.param("testName");
    const agent = await createAgent();
    
    // Register the agent
    let registrationError: string | undefined;
    try {
      await agent.register();
    } catch (error: any) {
      registrationError = error.message || String(error);
    }
    
    if (registrationError) {
      return c.json(
        {
          success: false,
          agentAccountId: agent.accountId(),
          registrationError,
        },
        500
      );
    }
    
    // Store the agent for later use
    registeredAgents.set(testName, agent);
    
    return c.json({
      success: true,
      agentAccountId: agent.accountId(),
    });
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

// Test endpoints
app.post("/test/wrong-measurements-rtmr2", async (c) => {
  try {
    const agent = await createAgent();
    const result = await testWrongMeasurementsRtmr2(agent);
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
    const agent = await createAgent();
    const result = await testWrongKeyProvider(agent);
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
    const agent = await createAgent();
    const result = await testWrongAppCompose(agent);
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
    const agent = await createAgent();
    const result = await testWrongPpid(agent);
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
    const agent = await createAgent();
    const result = await testDifferentAccountId(agent);
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
    // Retrieve the stored agent (should have been registered already)
    const agent = registeredAgents.get("measurements-removed");
    if (!agent) {
      return c.json(
        {
          success: false,
          error: "Agent not found. Please call /test/register-agent/measurements-removed first.",
        },
        400
      );
    }
    const result = await testMeasurementsRemoved(agent);
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
    // Retrieve the stored agent (should have been registered already)
    const agent = registeredAgents.get("ppid-removed");
    if (!agent) {
      return c.json(
        {
          success: false,
          error: "Agent not found. Please call /test/register-agent/ppid-removed first.",
        },
        400
      );
    }
    const result = await testPpidRemoved(agent);
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

app.post("/test/successful-registration", async (c) => {
  try {
    const agent = await createAgent();
    const result = await testSuccessfulRegistration(agent);
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
