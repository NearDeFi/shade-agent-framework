import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import dotenv from "dotenv";
import { ShadeClient } from "@neardefi/shade-agent-js";
import ethAccount from "./routes/ethAccount";
import agentAccount from "./routes/agentAccount";
import transaction from "./routes/transaction";

// Load environment variables from .env file (only needed for local development)
if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}

const agentContractId = process.env.AGENT_CONTRACT_ID;
const sponsorAccountId = process.env.SPONSOR_ACCOUNT_ID;
const sponsorPrivateKey = process.env.SPONSOR_PRIVATE_KEY;

if (!agentContractId || !sponsorAccountId || !sponsorPrivateKey) {
  throw new Error("Missing required environment variables AGENT_CONTRACT_ID, SPONSOR_ACCOUNT_ID, SPONSOR_PRIVATE_KEY");
}

// Initialize agent
export const agent = await ShadeClient.create({
  networkId: "testnet",
  agentContractId: agentContractId,
  sponsor: {
    accountId: sponsorAccountId,
    privateKey: sponsorPrivateKey,
  },
  derivationPath: sponsorPrivateKey,
});

// Initialize app
const app = new Hono();

// Middleware
app.use(cors());

// Routes
app.get("/", (c) => c.json({ message: "App is running" }));
app.route("/api/eth-account", ethAccount);
app.route("/api/agent-account", agentAccount);
app.route("/api/transaction", transaction);

console.log("Agent account ID:", agent.accountId());
console.log("Waiting for agent to be whitelisted...");

// Wait until the agent is whitelisted to register
while (true) {
  const status = await agent.isRegistered();
  if (status.whitelisted) {
    if (await agent.balance() < 0.2) {
      await agent.fundAgent(0.3);
    }
    const registered = await agent.register();
    console.log("registered");
    if (registered) {
      break;
    }
  }
  await new Promise(resolve => setTimeout(resolve, 10000));
}

// Start server after registration is complete
const port = Number(process.env.PORT || "3000");
console.log(`Server starting on port ${port}...`);
serve({ fetch: app.fetch, port });
