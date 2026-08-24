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
| **tee_config** | Yes if TEE | Which TEE the agent is measured for and deployed to. See [tee_config](#tee_config-tee-only). |
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

- `<PPIDS>` — Resolves to a mock PPID for local. For TEE the source depends on the deploy backend: with `tee_config.phala` it is the list of all PPIDs of devices on Phala Cloud; with `tee_config.server` it is the single PPID of your server's CPU package, read out of the PCK certificate embedded in its KMS's bootstrap attestation, so the server must be reachable for `shade deploy` and `shade plan` alike. A literal PPID written into `args` instead of the placeholder keeps working either way.

### build_docker_image (TEE Only)

| Key | Required | Description |
|-----|----------|-------------|
| **enabled** | No | If `false`, the Docker image is not built. If disabled, the CLI will use the existing Docker Compose file.  |
| **tag** | Yes | Docker image tag (e.g. `username/my-first-agent`) for building and pushing. |
| **cache** | No | Boolean; whether to use caching in the build process. Defaults to `false` when omitted. |
| **dockerfile_path** | Yes | Path to the Dockerfile to use for the build process (e.g. `./Dockerfile`). |
| **reproducible_build** | No | If `true`, builds a reproducible Docker image. Your Dockerfile should pin base images by digest. You need **buildx** installed to use this flag.|

### tee_config (TEE Only)

Everything about the TEE the agent is measured for and deployed to. The top-level fields feed the measurements and are read whether or not anything is deployed; `deploy` holds the deploy-only config; `phala` / `server` select the target.

| Key | Required | Description |
|-----|----------|-------------|
| **dstack_version** | Yes | The dstack OS image version to deploy with and to use when calculating measurements. Supported: `0.5.7`, `0.5.8`. |
| **instance_type** | Yes | The hardware instance type to use when calculating measurements. With the `server` target it also fixes the vCPU/memory the CVM is created with, because `rtmr0` measures both. Supported: `tdx.small`, `tdx.medium`, `tdx.large`, `tdx.xlarge`, `tdx.2xlarge`, `tdx.4xlarge`, `tdx.8xlarge`. |
| **public_logs** | Yes | Boolean. If `true`, the dstack guest-agent's `GET /logs/<container>` endpoint is publicly reachable on port 8090, exposing all container logs. Part of the app compose, so it is measured. |
| **public_sysinfo** | Yes | Boolean. If `true`, the dstack guest-agent's `GET /metrics` endpoint is publicly reachable on port 8090, exposing OS, CPU, memory, swap, uptime, load, and disk telemetry. Part of the app compose, so it is measured. |
| **deploy** | No | Deploy the agent. If omitted or disabled, measurements and PPIDs are still computed and approved but nothing is deployed. See [deploy](#tee_configdeploy). |
| **phala** | One of two | Target Phala Cloud. See [phala](#tee_configphala). |
| **server** | One of two | Target your own self-hosted dstack server over SSH. See [server](#tee_configserver). |

Exactly one of `phala` / `server` must be enabled whenever measurements, PPIDs, or a deploy need a target.

#### tee_config.deploy

| Key | Required | Description |
|-----|----------|-------------|
| **enabled** | No | If `false`, nothing is deployed. Measurements and PPIDs are still approved, so you can pre-approve an image and deploy it later or by hand. |
| **app_name** | Yes if enabled | The name the CVM is given. Not measured — the app compose always carries an empty name, so renaming does not change your measurements. |
| **env_file_path** | Yes if enabled | Path to the environment variables file (e.g. `./.env`). Only the variable *names* are measured, and they come from the `${VAR}` references in your docker-compose, not from this file — so changing a secret's value needs no re-approval, but adding a new variable to the compose does. Env vars are validated against the limits the dstack guest enforces before boot: at most 1024 variables, 1 MB in total, 128 KB per value, names of at most 255 characters matching `^[a-zA-Z_][a-zA-Z0-9_]*$`. |

#### tee_config.phala

| Key | Required | Description |
|-----|----------|-------------|
| **enabled** | No | If `true`, Phala Cloud is the target. Needs a Phala API key stored via `shade auth` when deploying. |

#### tee_config.server

Targets your own dstack server over SSH. The server must already be set up with `dstack-vmm`, a KMS CVM and a gateway CVM, and the VM shape must match one of the `instance_type` rows.

| Key | Required | Description |
|-----|----------|-------------|
| **enabled** | No | If `true`, your own server is the target. |
| **ssh_host** | Yes if enabled | SSH destination — an alias from your `~/.ssh/config` or `user@host`. Must be `[user@]host` using only letters, digits, dot, dash and underscore, and must not start with `-`. Required even when not deploying, because it is how the CLI reaches the server's KMS to compute the key-provider digest and read the PPID. |
| **gateway_domain** | Yes if deploying | The domain the dstack gateway serves under (e.g. `shade.example.com`). The app is reachable at `https://<app-id>-<port>.<gateway_domain>`. |
| **disk_size_gb** | Yes if deploying | Encrypted disk size in GB (positive integer). Not measured. |

The VMM and KMS endpoints (`http://127.0.0.1:10000`, `https://127.0.0.1:11001`), the gateway RPC port (`9202`) and the KMS allowlist path (`/opt/shade/kms/auth-config.json`) are constants in the CLI, reached by tunnelling `curl` through `ssh_host`. Nothing is installed on the server.

Notes on this target:

- **Redeploys create a new CVM.** Same as Phala — existing CVMs are managed at the VMM console (`http://127.0.0.1:10000/`, reachable with `ssh -L 10000:127.0.0.1:10000 <ssh_host>`). A deploy that fails *after* the CVM is created — a post-condition mismatch or a boot error — also leaves that CVM running and its allowlist entry in place, so clean both up at the console before retrying.
- **A fresh app id per deploy.** The app id is random rather than derived from the compose, so two deploys of the same image can't collide on the KMS-derived disk and env keys. The consequence is that the app URL changes every deploy and the CVM starts with a fresh encrypted disk — no state survives a redeploy.
- **The apps map grows one entry per deploy.** Each deploy adds an entry to `auth-config.json` on the server so its KMS will hand out keys. A stale entry still lets that old image boot, so prune the map when you retire an image. Entries the CLI added carry a `_shade` marker naming the app and deploy time; nothing is pruned automatically.
- **Env confidentiality depends on the server's KMS being genuine.** The CLI pins the recovered signer of the env encryption key to the KMS's own `k256_pubkey` and refuses to continue on a mismatch. A fully compromised host could still lie about both and read the environment. What it cannot do is produce a *registered* agent — the `key_provider_event_digest` approved on chain is derived from the same KMS CA, so a substituted KMS fails registration. Verifying the KMS CVM's own quote would close this properly and is not done yet.

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

The vCPU/memory each type maps to (1 vCPU / 2 GB for `tdx.small`, doubling upward) is what the `server` target provisions, because `rtmr0` measures both. Only `tdx.small` is documented by Phala; check a larger type with `dstack-mr measure` against the row's `rtmr0` before its first self-hosted use.

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
