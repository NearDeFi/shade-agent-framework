# new-shade

Please review the [NOTICE.txt](NOTICE.txt) before proceeding. 

Deployment is working for local, let me know before you try deploy to TEE, it hasnt been used yet.

Since this is still experimental please review the library and the contract and perform tests to make sure you are happy with them before proceeding.

Its recommended to use omni-transaction-rs to restrict the actions the agent can take https://github.com/near/omni-transaction-rs

First build the library 

```bash
cd shade-api-ts
npm i
npm run build
```

Install dependencies in the cli 

```bash
cd ../shade-agent-cli
npmi
```

Install dependencies in the template 

```bash
cd ../agent-template
npm i
```

Fill in the environment variables in a .env within the template 

```bash
AGENT_CONTRACT_ID=
SPONSOR_ACCOUNT_ID=
SPONSOR_PRIVATE_KEY=
ACCOUNT_ID=
PRIVATE_KEY=
PHALA_KEY=
```

for local you can leave out phala key, the sponsor account id and account id can be the same, the sponsor private key and private key can be the same. 

Fill out the contract_id in the deployment.yaml file.

Run the CLI

```bash
npm run shade:cli
```

Start the agent 

```bash
npm run dev
```

Whitelist the agent account id thats shared when you run it 
Edit the command
```bash
near contract call-function as-transaction your_contract_id whitelist_agent json-args '{"account_id": "your_agents_account_id"}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as my_example_signer_account network-config testnet sign-with-plaintext-private-key your_private_key send
```

Review the contract for other functions like removing agents and updating the owner.


## Migrating to this new setup 

- .env.development.local.example -> .env by default 
- Fewer environment variables
- Remove shade-agent-api from docker-compose.yaml
- Edit environment variables passed in docker-compose.yaml
- Copy deployment.yaml
- contract id does not need to be a sub account of the account id 
- You need to create an shade client for example

```js
export const agent = await ShadeClient.create({
  networkId: "testnet",
  agentContractId: agentContractId,
  sponsor: {
    accountId: sponsorAccountId,
    privateKey: sponsorPrivateKey,
  },
  derivationPath: sponsorPrivateKey,
});
```

- All agent functions are now accessible under the client

From `const accountId = await agentAccountId();` to ` const accountId = agent.accountId();`, from `const balance = await agent.balance();` to `const balance = await agent("getBalance");`.

- You need to whitelist the agent manually before it can register, you should implement some logic for the agent to start when it is registered, for example

```js
while (true) {
  const status = await agent.isRegistered();
  if (status.whitelisted) {
    const registered = await agent.register();
    if (registered) {
      break;
    }
  }
  await new Promise(resolve => setTimeout(resolve, 10000));
}

const port = Number(process.env.PORT || "3000");
console.log(`Server starting on port ${port}...`);
serve({ fetch: app.fetch, port });
```

- requestSignature method is no longer supported, use call method

```js
    const signRes = await agent.call({
      methodName: "request_signature",
      args: {
        path: "ethereum-1",
        payload: uint8ArrayToHex(hashesToSign[0]),
        key_type: "Ecdsa",
      },
    });
```

- Methods no longer return json so no need to do balance.balance after doing agent.balance()

```js
    // Get the agent's account ID
    const accountId = agent.accountId();

    // Get the balance of the agent account
    const balance = await agent.balance();

    return c.json({
      accountId,
      balance: balance.toString(),
    });
```


If you want to start the agent again you don't need to run the CLI 

If you want to reconfigure something in the contract like switching to mainnet you should run the CLI again
