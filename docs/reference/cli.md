# Shade Agent CLI

The **Shade Agent CLI** makes it easy to deploy a Shade Agent. It includes building and deploying your agent contract, building and publishing your agent's Docker image, and deploying the agent to a TEE — either Phala Cloud or your own self-hosted dstack server. The CLI revolves around a `deployment.yaml` file that configures how your Shade Agent will be deployed.

---

## Installation

```bash
npm install -g @neardefi/shade-agent-cli
```

---

## Commands 

### Deploy

Deploys your Shade Agent with the configuration as defined by the `deployment.yaml` file.

```bash
shade deploy
```

Must be executed in the same directory as your `deployment.yaml` file.

### Reproduce

Produces the hash of the reproducible Docker image and the app compose hash. Used when verifying the code.

```bash
shade reproduce
```

Must be executed in the same directory as your `deployment.yaml` file.

### Plan

Generates a preview of how your Shade Agent will be deployed as defined by the `deployment.yaml` file.

```bash
shade plan
```

Must be executed in the same directory as your `deployment.yaml` file.

### Whitelist 

Whitelists a specified agent's account ID in the agent contract as defined by the `deployment.yaml` file. This is only relevant for local mode.

```bash
shade whitelist
```

Must be executed in the same directory as your `deployment.yaml` file.

### Auth

Configure **NEAR**, **Phala** and **RPC** credentials required for deploying your Shade Agent. Must be run before using the `deploy` or `whitelist` commands.

```bash
shade auth
```

---


## deployment.yaml Reference

CLI configurations are read from a single `deployment.yaml` file in the project root. The following sections describe what each key configures.

**Boolean fields** (every `enabled` flag, plus `delete_key`, `cache`, `reproducible_build`, `public_logs`, `public_sysinfo`) must be exactly `true` or `false`. Optional booleans may also be omitted; non-boolean values like `yes`, `no`, `1`, `0`, or quoted `"true"` are rejected by the parser.

### Top-Level Keys

| Key | Required | Description |
|-----|----------|-------------|
| **environment** | Yes |`local` or `TEE`. Controls whether the agent runs locally or in a Phala TEE. |
| **network** | Yes | `testnet` or `mainnet`. Controls whether the agent contract is on NEAR testnet or mainnet. |
| **docker_compose_path** | Yes if TEE | Path to the Docker Compose file (e.g. `./docker-compose.yaml`). Used for building the Docker image and deploying your application to a TEE. |
| **agent_contract** | Yes | Agent contract configuration. See [agent_contract](#agent_contract) for more details. |
| **approve_measurements** | No | If enabled, sets allowed measurements in the agent contract. |
| **approve_ppids** | No | If enabled, sets allowed PPIDs in the agent contract.|
| **build_docker_image** | No (TEE only) | If enabled and environment is TEE, builds a new Docker image for your agent, publishes it, and updates the Docker Compose with the new image.  |
| **tee_config** | Yes if deploying to a TEE, or if `<MEASUREMENTS>` / `<PPIDS>` are used | Which TEE the agent is measured for and deployed to. Not needed when the approval args carry literal values and nothing is deployed. See [tee_config](#tee_config-tee-only). |
| **whitelist_agent_for_local** | No | Config for the `shade whitelist` command to whitelist an agent's account ID whilst in local mode (not used by the shade deploy command). |
| **os** | No | Override OS for tooling: `mac` or `linux`. If omitted, the CLI auto-detects from the current platform. |

### agent_contract

| Key | Required | Description |
|-----|----------|-------------|
| **contract_id** | Yes | NEAR account ID for the agent contract (e.g. `example-contract-123.testnet`). Must be unused if you are deploying a new contract. |
| **deploy_custom** | No | If enabled, the CLI creates the contract account with the same private key as the account set up via `shade auth`, and deploys a new contract. If the contract account already exists, the CLI wipes the existing contract's stored state by deploying a state cleaning contract and then deploys the new contract on top. If the state cannot be cleared, try configuring a different RPC in `shade auth`. |

#### deploy_custom

`agent_contract.deploy_custom`

| Key | Required | Description |
|-----|----------|-------------|
| **enabled** | No | If `false`, deploy_custom is skipped. |
| **funding_amount** | Yes | NEAR amount to fund the new contract account with, used to fund the deployment of the contract from the master account (number between 0 and 100). If the contract account already has funds it will be topped up to the funding amount. |
| **delete_key** | No | If `true`, the key for the contract account is deleted after deployment, locking the contract (defaults `false`). |
| **deploy_from_source** | One of three | Build the contract from source and deploy: set `enabled: true` and `source_path` to the contract directory. See [deploy_from_source](#deploy_from_source). |
| **deploy_from_wasm** | One of three | Deploy a pre-built WASM file: set `enabled: true` and `wasm_path` to the `.wasm` file. |
| **use_global_by_hash** | One of three | Deploy using a global contract: set `enabled: true` and `global_hash` to the contract hash. |
| **init** | No | If enabled, initializes the contract via a function call. |

#### deploy_from_source

`agent_contract.deploy_custom.deploy_from_source`

| Key | Required | Description |
|-----|----------|-------------|
| **enabled** | No | If `false`, this deploy path is not used. Exactly one of `deploy_from_source`, `deploy_from_wasm`, or `use_global_by_hash` must be the active option. |
| **source_path** | Yes | Path to the NEAR contract crate directory (the folder that contains `Cargo.toml`). |
| **reproducible_build** | No | If `true`, the CLI builds a reproducible contract. To use this flag, you need **cargo-near** installed. Make sure to set the `repository` field in `Cargo.toml` to your real Git remote URL and push your latest changes to GitHub. You can find more information about reproducible builds [here](https://github.com/SourceScan/verification-guide). |

#### init 

`agent_contract.deploy_custom.init`

| Key | Required | Description |
|-----|----------|-------------|
| **enabled** | No | If `false`, init is skipped. |
| **method_name** | Yes | Contract method to call (e.g. `new`). |
| **args** | Yes | Arguments to call the method with. |
| **tgas** | No | Gas for the call (default 30). |

Placeholders in args:

- `<REQUIRES_TEE>` — Resolves to `true` or `false` depending on `environment`.
- `<7_DAYS>` — Resolves to 7 days in milliseconds (604800000).
- `<MASTER_ACCOUNT_ID>` — Resolves to the NEAR account ID from `shade auth`.
- `<DEFAULT_MPC_CONTRACT_ID>` — Resolves to the default MPC contract for the selected `network` (testnet/mainnet).

### approve_measurements

| Key | Required | Description |
|-----|----------|-------------|
| **enabled** | No | If `false`, measurements are not approved. |
| **method_name** | Yes | Contract method to call (e.g. `approve_measurements`). |
| **args** | Yes | Arguments to call the method with. |
| **tgas** | No | Gas for the call (default 30). |

Placeholders in args:

- `<MEASUREMENTS>` — Resolves to real calculated measurements for the application for TEE and mock measurements for local. For TEE, the measurements depend on the docker compose file, the dstack version and instance type.

> **Note:** When `args` contains `<MEASUREMENTS>` in TEE mode, the placeholder is computed from `tee_config.dstack_version`, `instance_type`, `public_logs`, and `public_sysinfo`. These are read whether or not anything is deployed, so `tee_config` is required with a target selected even when `tee_config.deploy.enabled: false`. If `args` doesn't reference `<MEASUREMENTS>`, `tee_config` is not required for this.
>
> With `tee_config.server` as the target, the `key_provider_event_digest` in the measurements is computed from your own KMS over SSH rather than pinned to Phala's, so both `shade deploy` and `shade plan` need the server to be reachable to resolve `<MEASUREMENTS>`. On the Phala backend the measurements are computed entirely locally.

### approve_ppids

| Key | Required | Description |
|-----|----------|-------------|
| **enabled** | No | If `false`, PPIDs are not approved. |
| **method_name** | Yes | Contract method to call (e.g. `approve_ppids`). |
| **args** | Yes | Arguments to call the method with. |
| **tgas** | No | Gas for the call (default 30). |

Placeholders in args:

- `<PPIDS>` — Resolves to a mock PPID for local. For TEE the source depends on the deploy backend: with `tee_config.phala` it is the list of all PPIDs of devices on Phala Cloud; with `tee_config.server` it is the single PPID of your server. The server must be reachable for `shade deploy` and `shade plan` when using the placeholder. A literal PPID written into `args` instead of the placeholder keeps working either way.

### build_docker_image (TEE Only)

| Key | Required | Description |
|-----|----------|-------------|
| **enabled** | No | If `false`, the Docker image is not built. If disabled, the CLI will use the existing Docker Compose file.  |
| **tag** | Yes | Docker image tag (e.g. `username/my-first-agent`) for building and pushing. |
| **cache** | No | Boolean; whether to use caching in the build process. Defaults to `false` when omitted. |
| **dockerfile_path** | Yes | Path to the Dockerfile to use for the build process (e.g. `./Dockerfile`). |
| **reproducible_build** | No | If `true`, builds a reproducible Docker image. Your Dockerfile should pin base images by digest. You need **buildx** installed to use this flag.|

### tee_config (TEE Only)

Settings for the TEE the agent is measured for and deployed to. The top-level fields feed the measurements and are read whether or not anything is deployed; `deploy` holds the deploy-only config; `phala` / `server` select the target.

| Key | Required | Description |
|-----|----------|-------------|
| **dstack_version** | Yes if deploying, or if `<MEASUREMENTS>` is used | The dstack OS image version to deploy with and to use when calculating measurements. Supported: `0.5.7`, `0.5.8`. |
| **instance_type** | Yes if deploying, or if `<MEASUREMENTS>` is used | The hardware instance type to use when calculating measurements, and the amount of resources to deploy with. Supported: `tdx.small`, `tdx.medium`, `tdx.large`, `tdx.xlarge`, `tdx.2xlarge`, `tdx.4xlarge`, `tdx.8xlarge`. |
| **public_logs** | Yes if deploying, or if `<MEASUREMENTS>` is used | Boolean. If `true`, the dstack guest-agent's `GET /logs/<container>` endpoint is publicly reachable on port 8090, exposing all container logs. Part of the app compose, so it is measured. |
| **public_sysinfo** | Yes if deploying, or if `<MEASUREMENTS>` is used | Boolean. If `true`, the dstack guest-agent's `GET /metrics` endpoint is publicly reachable on port 8090, exposing OS, CPU, memory, swap, uptime, load, and disk telemetry. Part of the app compose, so it is measured. |
| **deploy** | No | Deploy the agent. If omitted or disabled, measurements and PPIDs are still computed and approved but nothing is deployed. See [deploy](#tee_configdeploy). |
| **phala** | One of two when deploying, or if `<MEASUREMENTS>` or `<PPIDS>` are used | Target Phala Cloud. See [phala](#tee_configphala). |
| **server** | One of two when deploying, or if `<MEASUREMENTS>` or `<PPIDS>` are used | Target your own self-hosted dstack server over SSH. See [server](#tee_configserver). |

Enabling both targets is an error.

#### tee_config.deploy

| Key | Required | Description |
|-----|----------|-------------|
| **enabled** | No | If `false`, nothing is deployed. |
| **app_name** | Yes if enabled | The name the CVM is given on dashboards. Not measured — the app compose always carries an empty name, so renaming does not change your measurements. |
| **env_file_path** | Yes if enabled | Path to the environment variables file (e.g. `./.env`) used in deployment. Your docker-compose decides which variables are sent: only the names it references as `${VAR}` are passed to the CVM, and a compose that references none sends nothing. Those names are the only measured part, so changing this file path does not affect the measurements. |

#### tee_config.phala

| Key | Required | Description |
|-----|----------|-------------|
| **enabled** | No | If `true`, Phala Cloud is the target: measurements and PPIDs are calculated for it when the placeholders are used, and the agent is deployed to it when `deploy` is enabled. Needs a Phala API key stored via `shade auth` when deploying. |

#### tee_config.server

Targets your own dstack server over SSH. The server must already be set up with `dstack-vmm`, a KMS CVM and a gateway CVM, and the VM shape must match one of the `instance_type` rows.

| Key | Required | Description |
|-----|----------|-------------|
| **enabled** | No | If `true`, your own server is the target: measurements and PPIDs are calculated for it when the placeholders are used, and the agent is deployed to it when `deploy` is enabled. |
| **ssh_host** | Yes if enabled | SSH destination — an alias from your `~/.ssh/config` or `user@host`. |
| **gateway_domain** | Yes if deploying | The domain the dstack gateway serves under (e.g. `shade.example.com`). The app is reachable at `https://<app-id>-<port>.<gateway_domain>`. |
| **disk_size_gb** | Yes if deploying | Encrypted disk size in GB (positive integer). Not measured. |

### whitelist_agent_for_local (local only)

Used by `shade whitelist`. No `enabled` flag; if the section is present, the command is available.

| Key | Required | Description |
|-----|----------|-------------|
| **method_name** | Yes | Contract method to call (e.g. `whitelist_agent_for_local`). |
| **args** | Yes |  Arguments to call the method with. |
| **tgas** | No | Gas for the call (default 30). |

Placeholders in args:

- `<AGENT_ACCOUNT_ID>` — Replaced with the agent account ID you provide when running `shade whitelist`.

---

## Supported configurations

The Shade Agent CLI supports specific Phala Cloud / Dstack configurations, as listed below. They apply to both deploy backends, except that the self-hosted `key_provider_event_digest` is computed from your own KMS rather than pinned to Phala's.

**Dstack image versions:**

`0.5.8` and `0.5.7`

**Instance types:**

`tdx.small`, `tdx.medium`, `tdx.large`, `tdx.xlarge`, `tdx.2xlarge`, `tdx.4xlarge`, `tdx.8xlarge`

The vCPU/memory each type maps to is 1 vCPU / 2 GB for `tdx.small`, doubling upward. These are the only hardware configurations that can be set for Phala Cloud, but on your own server you can technically deploy with different hardware configurations, although that is not supported by the CLI. If you would like to deploy with different configurations, reach out.

**QEMU versions:**

`8.2.2`

**App compose configs:**
- Pre Launch Script: v0.0.13

...

- features: ["kms", "tproxy-net"],
- gateway_enabled: true,
- kms_enabled: true,
- local_key_provider_enabled: false,
- manifest_version: 2,
- name: "",
- no_instance_id: false,
- public_logs: per `tee_config.public_logs` (configurable, see table above)
- public_sysinfo: per `tee_config.public_sysinfo` (configurable, see table above)
- public_tcbinfo: true,
- runner: "docker-compose",
- secure_time: false,
- storage_fs: "zfs",
- tproxy_enabled: true,

---

## Example deployment.yaml Configurations

You can view a list of [example deployment.yaml configurations here](https://github.com/NearDeFi/shade-agent-framework/tree/main/shade-agent-cli/example-deployment-files).
