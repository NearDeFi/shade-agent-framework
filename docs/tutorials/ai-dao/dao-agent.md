# DAO Agent

On this page, you'll examine the agent component of the DAO. The agent continuously monitors for new proposals, uses an LLM to evaluate them, and submits its vote along with reasoning back to the smart contract.

---

## Starting the Agent

Before an agent can execute any actions on-chain, it must first be `registered`. When in production (running on Phala Cloud, not locally), the agent runs a loop to check its registration status. An agent can see if it's registered using the `agentInfo` function provided by `shade-agent-js`; once registered, `agentInfo` will return a checksum.

After the agent is registered, it starts the `responder`, which contains the core logic of the agent.

```ts
async function startResponder() {
  if (process.env.NODE_ENV === "production") { // If in production wait until agent is registered to start the responder
    while (true) {
      await new Promise(resolve => setTimeout(resolve, 10000));
      console.log("Looping check if registered")
      try {
        const res = await agentInfo();
        const checksum = res.checksum;
        
        if (checksum && checksum !== null && checksum !== undefined) {
          break;
        }
      } catch (error) {
        console.error("Error in checksum loop:", error);
      }
    }
  }
  console.log("Starting responder");
  responder();
}
```

---

## Indexing Proposals

Once started, the responder begins a continuous loop to check for pending proposals by calling `get_pending_proposals` on the contract using the `agentView` function provided by `shade-agent-js`. The `agentView` function makes a view call (a gasless transaction that does not change the contract's state) to the selected function on the agent contract.

```ts
// Fetch the pending proposals
const requests: [number, ProposalRequest][] = await agentView({
    methodName: "get_pending_proposals",
    args: {}
});

// If there are no pending proposals restart the loop
if (requests.length === 0) {
    console.log("No pending proposals");
    continue;
}
```

If proposals are found, the agent extracts the `proposal text` and `yield ID` from the oldest pending proposal , then fetches the current manifesto from the DAO by calling `get_manifesto`.

```ts
// Extract the proposal text and yield id from the oldest proposal
const proposal_to_respond_to: [number, ProposalRequest] = requests[0];
const proposal_id: number = proposal_to_respond_to[0];
const yield_id: string = proposal_to_respond_to[1].yield_id;
const proposal_text: string = proposal_to_respond_to[1].proposal_text;

// Fetch the manifesto
const manifesto_text: string = await agentView({
    methodName: "get_manifesto",
    args: {}
});
```

Having retrieved both the proposal and manifesto, the agent is ready to make its decision using an LLM.

---

## Voting with an LLM

To make a decision on the proposal, the agent uses an LLM provided by [NEAR AI](https://docs.near.ai/cloud/get-started/). NEAR AI provides verifiable and private inference by running LLMs in GPU TEEs. In this tutorial, the DAO uses NEAR AI for its `verifiable` component. This allows the agent verify that no one is interfering with the LLM response, as could happen with centralized model hosting. The agent knows the response from the LLM is actually a function of the input, and comes from the expected model.

> [!NOTE]
> In this tutorial, the agent does not actually verify the attestation from the LLM. Full verification will be added in a future update to the tutorial.

The DAO uses the `Open AI SDK` to interact with the model. First, the agent sets up the client passing the `base URL` for NEAR AI and an `API key` for the Cloud (we'll explain how to obtain a key in the next section).

```ts
const openai = new OpenAI({
    baseURL: 'https://cloud-api.near.ai/v1',
    apiKey: process.env.NEAR_AI_API_KEY,
});
```

A request to an LLM typically takes two prompts:
- **The System Message** sets the `behavior and role` of the LLM. In this tutorial, the message explains to the model that it's acting as a DAO and needs to vote Approved or Rejected on proposals, making its decisions based on the manifesto.
- **The User Message** is the `input` that the LLM responds to. In typical chat applications, this would be any message you type to the assistant. In this tutorial, the user message is a combination of the proposal and the DAO's manifesto.

```ts
// Set the system message that will be sent to the AI model
const systemMessage = "You are a Decentralized Autonomous Organization (DAO) agent. You are responsible for making decisions on behalf of the DAO. Each prompt will contain the manifesto you use to vote and a proposal that you will vote on. You will vote on the proposal based on the manifesto. You will provide both your vote (Approved or Rejected) and a clear explanation of your reasoning based on how the proposal aligns with the manifesto. You must keep responses under 10,000 characters.";

// Create the user message that will be sent to the AI model, a combination of the manifesto and the proposal
const userMessage = `
Manifesto: ${manifesto}
Proposal: ${proposal}
`;
```

Next, the agent constructs the `JSON request` to send to the model. There are several important aspects of this request:
- The request specifies the `model` to call - in this tutorial, DeepSeek V3 0324. You can find a full list of [available models here](https://cloud.near.ai/models).
- The request is using `non-streaming` mode. This means the model waits until the full response is ready before returning it, rather than streaming, where the response is sent piece by piece while the model is still generating it. Non-streaming is simpler here as the agent doesn't need to display the response or take any action until the whole response is ready.
- The request uses `tool calling` to ensure that the model responds with a vote of exactly `Approved` or `Rejected` and `reasoning` for its choice. If the model fails to conform to the required output, it will return an error. You can read more on [tool calling/function calling here](https://platform.openai.com/docs/guides/function-calling).

```ts
const request: ChatCompletionCreateParamsNonStreaming = {
    model: "deepseek-ai/DeepSeek-V3.1",
    tools: [
      {
        type: "function",
        function: {
          name: "dao_vote",
          description: "Vote on a DAO proposal with reasoning",
          parameters: {
            type: "object",
            properties: { 
              vote: { type: "string", enum: ["Approved", "Rejected"] },
              reasoning: { type: "string", description: "Explanation for the voting decision based on the manifesto" }
            },
            required: ["vote", "reasoning"]
          }
        }
      }
    ],
    tool_choice: { type: "function", function: { name: "dao_vote" } },
    messages: [
      { 
        role: "system", 
        content: systemMessage 
      },
      { role: "user", content: userMessage }
    ]
};
```

The agent then sends the request to the model, extracts the vote and reasoning from the response, and performs a double check to ensure the response is in the expected format.

```ts
// Send the request to the AI model
const completion = await openai.chat.completions.create(request);

// Extract the information from the response
const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
if (!toolCall || toolCall.type !== 'function') {
    throw new Error('Expected function tool call response');
}
const rawResponse = JSON.parse(toolCall.function.arguments);
  
// Validate the vote is exactly "Approved" or "Rejected"
if (rawResponse.vote !== "Approved" && rawResponse.vote !== "Rejected") {
    throw new Error(`Invalid vote: "${rawResponse.vote}". Vote must be exactly "Approved" or "Rejected"`);
}

// Check that reasoning is under 10,000 characters
if (rawResponse.reasoning.length > 10000) {
    throw new Error(`AI response too long: ${rawResponse.reasoning.length} characters. Must be under 10,000 characters.`);
}
```

---

## Submitting the Vote

Once the agent receives the response from the LLM, it's nearly ready to submit the vote to the agent contract. Before sending the vote, the agent `hashes` both the proposal it's voting on and the manifesto it's using to make it's decision. This is done so the DAO can verify that the agent used the correct proposal and manifesto to vote and that the query wasn't corrupted by the RPC or intercepted and modified on transit to the agent.

```ts
const proposal_hash: string = crypto.createHash('sha256').update(proposal_text).digest('hex');
const manifesto_hash: string = crypto.createHash('sha256').update(manifesto_text).digest('hex');
```

The agent then calls `agent_vote` on the agent contract using the `agentCall` function provided by `shade-agent-js` to cast its vote. It includes the yield ID of the proposal's yielded promise that it's resuming, along with all required response fields.

```ts
const response = {
    proposal_id: proposal_id,
    proposal_hash: proposal_hash,
    manifesto_hash: manifesto_hash,
    vote: voteResult.vote,
    reasoning: voteResult.reasoning
};

await agentCall({
    methodName: "agent_vote",
    args: {
        yield_id: yield_id,
        response: response
    },
});
```

---

## Next Steps

That completes the overview of the DAO system as a whole! You can now fork the [repository](https://github.com/NearDeFi/verifiable-ai-dao/tree/main) to create your own yield and resume-based Shade Agent. On the [final page](./deploying.md) of this tutorial, you'll learn how to deploy the AI DAO yourself.
