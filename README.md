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
near contract call-function as-transaction your_contract_id whitelist_agent json-args '{"account_id": "your_agents_account_id"}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' sign-as my-brand-new-account.testnet network-config testnet sign-with-plaintext-private-key your_private_key send
```


Review the contract for other functions like removing agents and updating the owner.

If you want to start the agent again you don't need to run the CLI 

If you want to reconfigure something in the contract like switching to mainnet you should run the CLI again
