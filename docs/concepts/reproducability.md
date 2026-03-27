# Reproducibility

This page describes how to create a reproducible Docker image for your agent. Even though we have "reproducible" docker image builds, it is still not necessarily reproducible across different machines and environments. It is recommended to setup a reproducible environment and deploy agent / build your docker images from this environment and publish the setup instructions for the environment so others can reproduce these steps. 

Here is an example setup for producing reproducible images using an AWS EC2 instance.

---

## Publisher's instructions

### AWS Machine Setup

1) Setup a **free AWS account** if you don't have one already at https://signin.aws.amazon.com/signup?request_type=register.
2) Go to https://console.aws.amazon.com/ec2#LaunchInstances to start a new instance.
3) For distribution, select **Ubuntu**.
4) For Amazon Machine Image (AMI), select **Ubuntu Server 24.04 LTS (HVM), SSD Volume Type** 
5) For Architecture, select **64-bit (x86)**
6) For Instance Type, select **t3.small**
7) For Key Pair (login), create a new key pair or use an existing one.
8) For Network Settings, only allow SSH traffic and but allow from anywhere.
9) Configure Storage to **32GB**.
10) Then click on **Launch Instance**.

---

### Connect to the instance

1) Navigate to your instance, click **Connect** and **Connect** again.

---

### Installing tools 

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

### Recording the tool versions

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

### Deploying your agent 

Deploy your agent or build your docker image using the Shade Agent CLI with reproducible builds. Here is an example yaml file for a [production deployment](../../shade-agent-cli/example-deployment-files/example-3.yaml).

You can now publish your code with the git commit hash, the hash of the docker image and the output of the script.

---

## Verifier's instructions

### Reproducing the environment

Start a machine in the same way as the first machine.

#### 1 — Installing the same tools 
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

#### 2 — Checking the tool versions

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

### Verifying the code

#### 1 — Clone the repo at a specific commit

```bash
git clone REPO_URL PROJECT_DIR
cd PROJECT_DIR
git checkout COMMIT
```

#### 2 — Reproduce the docker image

```bash
shade reproduce
```

This will produce the hash of the docker image it should match the hash published.

### Building the reproduce tool yourself 

If you don't trust the published Shade Agent CLI you can clone the repo, inspect the code and run the reproduce command from the source.

```bash
git clone https://github.com/neardefi/shade-agent-cli.git
cd shade-agent-cli
npm install
cd ..
node shade-agent-cli/src/cli.js reproduce
```