# Reproducibility and Verifying Measurements

This page is for developers who want to create reproducible builds of their agent and for verifiers who want to verify the measurements of an agent.

There are quite a few layers of a Shade Agent to verify:

- [Smart Contract](#smart-contract)
- [TEE Physical Location](#tee-physical-location)
- [Application](#application)
  - App compose hash
- [Trusted Domain, Hardware, and OS](#trusted-domain-hardware-and-os-measurements)
  - MRTD
  - RTMR0
  - RTMR1
  - RTMR2
- [Key Provider](#key-provider-measurements)
  - Key provider event digest
- [Secure Connection](#secure-connection)
  - TLS certificates
  - CAA Records

---

# Smart Contract

## Developer's Instructions

When deploying your Shade Agent or agent contract, in your `deployment.yaml` file turn on the `deploy_from_source` option and set `reproducible_build` to `true`.

```yaml
deploy_from_source:
  enabled: true
  source_path: ./agent-contract
  reproducible_build: true
```

To use this flag, you need **cargo-near** installed. Make sure to set the `repository` field in `Cargo.toml` to your real Git remote URL and push your latest changes to GitHub. You can find more information about reproducible builds [here](https://github.com/SourceScan/verification-guide).

---

## Verifier's Instructions

Search for the smart contract on https://nearblocks.io/ and head over to Contract > Contract Code. This is the source code that is deployed to the blockchain. It should implement proper attestation verification and Shade Agent standards.

---

# TEE Physical Location

To verify the physical location security of the TEE machines, we use [PPID](../concepts/terminology.md#ppid). Call the `get_approved_ppids` method on the agent contract to return a list of approved PPIDs.

```bash
near contract call-function as-read-only CONTRACT_ID get_approved_ppids json-args {}
```

You can also view the PPIDs of agents themselves and verify that these match the approved PPIDs in the contract by calling the `get_agents` or `get_agent` methods on the agent contract.

```bash
near contract call-function as-read-only CONTRACT_ID get_agents json-args {}
```

```bash
near contract call-function as-read-only CONTRACT_ID get_agent json-args '{"account_id": "AGENT_ACCOUNT_ID"}'
```

You can then request a list of PPIDs from the TEE provider. Most commonly all PPIDs on Phala Cloud are approved, Phala have published a list of their PPIDs at https://cloud-api.phala.network/api/v1/attestations/ppids. The cloud provider may publish information about which data centers the machines are located in via the machine's PPID.

---

# Viewing Measurements

The next sections discuss the [measurements](../concepts/terminology.md#measurements) of the agent from the trusted execution environment (TEE) and the local environment.

To view the measurements of an agent, you call the `get_approved_measurements` method on the agent contract. Only agents with these measurements can register in the contract.

```bash
near contract call-function as-read-only CONTRACT_ID get_approved_measurements json-args {}
```

You can also view the measurements of agents themselves and verify that these match the approved measurements in the contract by calling the `get_agents` or `get_agent` methods on the agent contract.

```bash
near contract call-function as-read-only CONTRACT_ID get_agents json-args {}
```

```bash
near contract call-function as-read-only CONTRACT_ID get_agent json-args '{"account_id": "AGENT_ACCOUNT_ID"}'
```

This will print the measurements of the agent. Note that there can be multiple sets of measurements. For each set, there should be declared source code and hardware/OS configurations published so verifiers can compare these to the measurements to verify the agent.

---

# Application

The application is measured by the app compose hash. It is the hash of the Docker Compose file and app layer configurations.

This section describes how to create a reproducible Docker image for your agent. Even though the framework supports "reproducible" Docker image builds, it is still not necessarily reproducible across different machines and environments. Some machines give the same hash for the same Docker image build, but others do not.

It is recommended to set up a reproducible environment, deploy your agent/build your Docker image from this environment, and publish the setup instructions so others can reproduce these steps.

Here is an example setup for producing reproducible images using an AWS EC2 instance.

---

## Developer's Instructions

### AWS Machine Setup

1) Set up a **free AWS account**, if you don't have one already, at https://signin.aws.amazon.com/signup?request_type=register.
2) Go to https://console.aws.amazon.com/ec2#LaunchInstances to start a new instance.
3) For distribution, select **Ubuntu**.
4) For Amazon Machine Image (AMI), select **Ubuntu Server 24.04 LTS (HVM), SSD Volume Type**.
5) For Architecture, select **64-bit (x86)**.
6) For Instance Type, select **t3.small**
7) For Key Pair (login), create a new key pair or use an existing one.
8) For Network Settings, only allow SSH traffic and allow only from your IP address.
9) Configure Storage to **32GB**.
10) Then click on **Launch Instance**.

---

### Connect to the Instance

1) Navigate to your instance, click **Connect** and **Connect** again.

---

### Installing Tools

#### 1 — Git and Node runtime library

```bash
sudo apt-get update
sudo apt-get install -y git libatomic1
```

#### 2 — Docker (Engine, CLI, containerd, Buildx)

```bash
sudo apt-mark unhold git docker-ce docker-ce-cli containerd.io docker-buildx-plugin 2>/dev/null || true
sudo apt-get install -y ca-certificates curl
sudo install -dm0755 /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
sudo systemctl enable --now docker
```

#### 3 — Node.js (nvm)

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source "$HOME/.nvm/nvm.sh"
nvm install node
nvm alias default node
```

#### 4 — Shade Agent CLI

```bash
npm install -g @neardefi/shade-agent-cli@latest
```

---

### Recording the Tool Versions

```bash
source "$HOME/.nvm/nvm.sh" 2>/dev/null || true

{
  echo "# toolchain snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ) on $(hostname)"
  dpkg-query -W -f '${binary:Package}=${Version}\n' git docker-ce docker-ce-cli containerd.io docker-buildx-plugin 2>/dev/null
  sudo docker version
  echo "NODE_VER=$(node -v)"
  echo "NPM_VER=$(npm -v)"
  npm list -g @neardefi/shade-agent-cli --depth=0 2>/dev/null | tail -n 1
} | tee toolchain-lock.txt

GIT_VER=$(dpkg-query -W -f '${Version}' git)
DOCKER_CE_VER=$(dpkg-query -W -f '${Version}' docker-ce)
CONTAINERD_VER=$(dpkg-query -W -f '${Version}' containerd.io)
BUILDX_VER=$(dpkg-query -W -f '${Version}' docker-buildx-plugin)
NODE_PRINT=$(node -v)
SHADE_CLI_VER=$(npm list -g @neardefi/shade-agent-cli --depth=0 2>/dev/null | sed -n 's/.*shade-agent-cli@//p' | tr -d ' ')

echo "export GIT_VER='${GIT_VER}'"
echo "export DOCKER_CE_VER='${DOCKER_CE_VER}'"
echo "export CONTAINERD_VER='${CONTAINERD_VER}'"
echo "export BUILDX_VER='${BUILDX_VER}'"
echo "export NODE_VER='${NODE_PRINT}'"
echo "export SHADE_CLI_VER='${SHADE_CLI_VER}'"
```

Record the output of the script.

---

### Deploying Your Agent

Deploy your agent or build your Docker image using the Shade Agent CLI with reproducible builds. Here is an example YAML file for a [production deployment](../../shade-agent-cli/example-deployment-files/example-3.yaml).

You should then publish your code with the Git commit hash and the output of the the previous script.

---

## Verifier's Instructions

### Reproducing the Environment

Start a machine in the same way as the first machine.

#### 1 — Installing the Same Tools

Paste the six `export` lines published, then run:
```bash
sudo apt-mark unhold git docker-ce docker-ce-cli containerd.io docker-buildx-plugin 2>/dev/null || true

sudo apt-get install -y ca-certificates curl
sudo install -dm0755 /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update

sudo apt-get install -y \
  "git=${GIT_VER}" \
  "docker-ce=${DOCKER_CE_VER}" \
  "docker-ce-cli=${DOCKER_CE_VER}" \
  "containerd.io=${CONTAINERD_VER}" \
  "docker-buildx-plugin=${BUILDX_VER}"

sudo systemctl enable --now docker

sudo apt-get install -y libatomic1

curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source "$HOME/.nvm/nvm.sh"
nvm install "${NODE_VER}"
nvm alias default "${NODE_VER}"

npm install -g "@neardefi/shade-agent-cli@${SHADE_CLI_VER}"
```

#### 2 — Checking the Tool Versions

Run the script on the machine and compare the output with the published output.

Run the same script on your machine and compare the output with the published output.

```bash
source "$HOME/.nvm/nvm.sh" 2>/dev/null || true

{
  echo "# toolchain snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ) on $(hostname)"
  dpkg-query -W -f '${binary:Package}=${Version}\n' git docker-ce docker-ce-cli containerd.io docker-buildx-plugin 2>/dev/null
  sudo docker version
  echo "NODE_VER=$(node -v)"
  echo "NPM_VER=$(npm -v)"
  npm list -g @neardefi/shade-agent-cli --depth=0 2>/dev/null | tail -n 1
} | tee toolchain-lock.txt

GIT_VER=$(dpkg-query -W -f '${Version}' git)
DOCKER_CE_VER=$(dpkg-query -W -f '${Version}' docker-ce)
CONTAINERD_VER=$(dpkg-query -W -f '${Version}' containerd.io)
BUILDX_VER=$(dpkg-query -W -f '${Version}' docker-buildx-plugin)
NODE_PRINT=$(node -v)
SHADE_CLI_VER=$(npm list -g @neardefi/shade-agent-cli --depth=0 2>/dev/null | sed -n 's/.*shade-agent-cli@//p' | tr -d ' ')

echo "export GIT_VER='${GIT_VER}'"
echo "export DOCKER_CE_VER='${DOCKER_CE_VER}'"
echo "export CONTAINERD_VER='${CONTAINERD_VER}'"
echo "export BUILDX_VER='${BUILDX_VER}'"
echo "export NODE_VER='${NODE_PRINT}'"
echo "export SHADE_CLI_VER='${SHADE_CLI_VER}'"
```

---

### Verifying the Code

#### 1 — Clone the Repository at a Specific Commit

```bash
git clone REPO_URL PROJECT_DIR
cd PROJECT_DIR
git checkout COMMIT
```

#### 2 — Reproduce the Docker Image

```bash
shade reproduce
```

This will produce the hash of the Docker image and the app compose hash. It should match the hashes published.

The Docker Compose file used to produce the app compose hash should always use a SHA256 digest instead of a tag like `latest`, otherwise the code served can change without the app compose hash changing.

### Building the Reproduce Tool Yourself

If you don't trust the published Shade Agent CLI, you can clone the [shade-agent-framework](https://github.com/neardefi/shade-agent-framework) repository, inspect the code, and run the reproduce command from source.

```bash
git clone https://github.com/neardefi/shade-agent-cli.git
cd shade-agent-cli
npm install
cd ..
node shade-agent-cli/src/cli.js reproduce
```

---

# Trusted Domain, Hardware, and OS

This section describes how to verify the measurements of the trusted domain, hardware, and OS that the agent is running on.

---

## Dstack Image Build

To verify these measurements, you need a build of the Dstack image used by the agent. The developer should publish the Dstack image version used.

Below are instructions for Dstack version 0.5.8. These instructions will slightly differ for other versions.

### Option 1: Download the Pre-Built Image Releases

Download the pre-built image releases from GitHub:

```bash
DSTACK_VERSION=0.5.8
wget "https://github.com/Dstack-TEE/meta-dstack/releases/download/v${DSTACK_VERSION}/dstack-${DSTACK_VERSION}.tar.gz"
mkdir -p images/
tar -xvf dstack-${DSTACK_VERSION}.tar.gz -C images/
rm -f dstack-${DSTACK_VERSION}.tar.gz
```

Enter the image directory:

```bash
cd images/dstack-0.5.8
```

### Option 2: Build the Image Yourself

Build the image yourself. This will take about 1-2 hours. It's recommended to build this on a high-spec machine (for example a c6in.8xlarge EC2 instance).

Clone and check out the exact release:

```bash
git clone https://github.com/Dstack-TEE/meta-dstack.git
cd meta-dstack/
git checkout 48dd3df6f443bfe25a65701d4453fb7cf9c3dbb9
git submodule update --init --recursive
```

Build a reproducible image from source:

```bash
cd repro-build && ./repro-build.sh -n
```

Enter the build directory:

```bash
cd dist
```

Extract the image:

```bash
tar xzf dstack-0.5.8.tar.gz
```

Enter the image directory:

```bash
cd dstack-0.5.8
```

You can follow the repro-build.sh script to verify the contents of the image.

---

## Verifying the Measurements

To verify the measurements, the dstack-mr tool is used within a Docker container. Build the Docker image:

```Dockerfile
# Dockerfile
FROM rust:1.86.0@sha256:300ec56abce8cc9448ddea2172747d048ed902a3090e6b57babb2bf19f754081 AS kms-builder
ARG DSTACK_REV
WORKDIR /build
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    git \
    build-essential \
    musl-tools \
    libssl-dev \
    protobuf-compiler \
    libprotobuf-dev \
    clang \
    libclang-dev
RUN git clone https://github.com/Dstack-TEE/dstack.git && \
    cd dstack
RUN rustup target add x86_64-unknown-linux-musl
RUN cd dstack && cargo build --release -p dstack-mr-cli --target x86_64-unknown-linux-musl

FROM kvin/kms:latest
COPY --from=kms-builder /build/dstack/target/x86_64-unknown-linux-musl/release/dstack-mr /usr/local/bin/
ENTRYPOINT ["dstack-mr"]
CMD []
```

Build the Docker image:

```bash
docker build . -t dstack-mr
```

Run the tool:

```bash
sudo docker run --rm \
  -v "$(pwd)":/dstack-0.5.8 \
  dstack-mr \
  measure -c 8 -m 64G --qemu-version 8.2.2 /dstack-0.5.8/metadata.json
```

This will produce the MRTD, RTMR0, RTMR1, and RTMR2 measurements. You can compare these with the measurements in the agent contract.

---

# Key Provider

While the key provider is measured in the Shade Agent Framework, it is not extensively used and is not critical to verify. It is only used as an additional source of entropy for agent account ID generation on top of JS crypto random. The "no key provider" option in Dstack is not supported on Phala Cloud.

The key provider event digest is set to Phala's centralized key provider by CLI default with a value of `83368b43a0fc6f824f5a9220592df85fd30e2d405ecbd253a5c6354af63e6c9b41aec557c38a38e348ab87f9ac8fc68c`. Any application should use this value for the key provider event digest unless there is a sufficient reason to use a different key provider.

---

# Secure Connection

Phala Cloud ensures that your connection to a TEE application is private and authentic. TLS certificate private keys are generated and controlled within the TEE hardware, meaning no one can intercept or decrypt your traffic. DNS CAA records further restrict certificate issuance to only the TEE's account, preventing unauthorized certificates.

You can verify all of this yourself by following Phala's attestation documentation https://phala.network/docs/concepts/attestation#domain-attestation.

---

# Trust Centre

For a given deployment on Phala Cloud, you can also view the [Trust Centre](https://trust.phala.com) for the deployment. This will share many of the details mentioned on this page.
