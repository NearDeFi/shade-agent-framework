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
```

Fill out the contract_id and docker tag in the deployment.yaml file.

Run the CLI

Set up auth in the CLI

```bash
npm run shade:cli auth
```

Deploy 

```bash
npm run shade:cli deploy
```

for local

Start the agent 

```bash
npm run dev
```

Whitelist the agent account id thats shared when you run it 
Edit the command
```bash
npm run shade:cli whitelist
```

Review the contract for other functions like removing agents and updating the owner.


## Migrating to this new setup 

- .env.development.local.example -> .env by default 
- Fewer environment variables
- Remove shade-agent-api from docker-compose.yaml
- Edit environment variables passed in docker-compose.yaml
- Copy the example deployment.yaml
- contract id does not need to be a sub account of the account id 
- You need to create a shade client for example

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

You may need to cast results into types now, this can be got from chainsig.js, see the transaction route for full example

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


phala deploy --name shade-test-2 --image dstack-0.5.4.1 -c docker-compose.yaml --env-file .env