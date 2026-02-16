# Example deployment files

Example `deployment.yaml` configurations for the [Shade Agent CLI](https://github.com/NearDeFi/shade-agent-framework/tree/main/shade-agent-cli). Copy the file that matches your scenario and adjust `contract_id`, paths, and other values for your project.

Run `shade deploy` (or `shade plan`) from the directory that contains your `deployment.yaml`.

---

| Example | Description |
|--------|-------------|
| [example-1.yaml](./example-1.yaml) | **First-time local (testnet).** Builds contract from source, deploys and initializes it, approves default measurements and PPIDs for local mode. |
| [example-2.yaml](./example-2.yaml) | **First-time TEE (testnet).** Full flow: build contract from source, deploy and init, approve measurements and Phala PPIDs, build Docker image, deploy to Phala Cloud. |
| [example-3.yaml](./example-3.yaml) | **Production (mainnet TEE).** Mainnet deployment, deploys to Phala Cloud, and deletes the contract key after deployment to lock the account. Plan to use a multisig for the owner and remove its key afterward. |
| [example-4.yaml](./example-4.yaml) | **New agent, same contract.** Reuse an existing agent contract; only approves measurements, builds the new agent image, and deploys to Phala Cloud. No contract deploy or init. |
| [example-5.yaml](./example-5.yaml) | **Pre-approved agent.** Deploying an agent to an existing Shade Agent system with approved measurements. Build and deploy agent to Phala only. |
| [example-6.yaml](./example-6.yaml) | **Refresh agent contract (local).** Same contract account but redeploy contract from a pre-built WASM file. |
| [example-7.yaml](./example-7.yaml) | **Custom measurements / Phala config.** Manual measurements (no `<MEASUREMENTS>` placeholder). Replace the hex values with your pre-calculated measurements and deploy to Phala manually. |
| [example-8.yaml](./example-8.yaml) | **Custom attestation expiration.** Same as a typical local/testnet setup but with attestation expiration set to 1 day (`86400000` ms) instead of 7 days. |
| [example-9.yaml](./example-9.yaml) | **Additional initialization arguments.** Same as a typical local/testnet setup but with additional arguments on init. |
