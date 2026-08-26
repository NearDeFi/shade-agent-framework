# Self-hosted TDX node for Shade Agents

## Placeholders

Anything in `<ANGLE_BRACKETS>` is yours to fill in.

## 1. Get a domain on Cloudflare

### 1a. Account

Sign up:

```
https://dash.cloudflare.com/sign-up
```

### 1b. Buy the domain

Click add a domain, buy a domain, search a name. Stick to .com .net .org .dev or .io.

### 1c. The DNS record

Your domain, then DNS, then Records, then Add record. One wildcard covers every app
and the gateway.

```text
Type            A
Name            *.shade
IPv4 address    <SERVER_IP>
Proxy status    DNS only
TTL             Auto
```

### 1d. API token

```
https://dash.cloudflare.com/profile/api-tokens
```

Create Token, then Edit zone DNS, Use template:

```text
Permissions       Zone / DNS / Edit          set by the template
Zone Resources    Include / Specific zone / <DOMAIN>
Client IP         leave blank
TTL               leave blank
```

Continue to summary, Create Token, copy it. It is only shown once. That value is
`CF_API_TOKEN` in step 20.

### 1e. Check

```bash
dig +short gateway.shade.<DOMAIN>
dig +short anything.shade.<DOMAIN>
```

Both should give <SERVER_IP>. Cloudflare records go live in seconds. If it is empty
the record didn't save.

## 2. Sign up and buy the server

Sign up:

```
https://bmc.phoenixnap.com/portal/home
```

Purchase the server:

```
https://bmc.phoenixnap.com/portal/servers/purchase
```

Hourly billing for testing. You can reserve if running in prod.

Go for type s5.x6.c3.medium. If not available can pick s5.x6.c3.large or s4.x6.c6.large.

Select Noble Ubuntu as the OS, and buy an IPv4.

Generate an SSH key before you finish, the form asks for the public key:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/tdx-ssh -C "tdx-shade-agent"
cat ~/.ssh/tdx-ssh.pub
```

Paste the whole public key into public SSH keys.

## 3. Get PCS key

Register

```
https://api.portal.trustedservices.intel.com/
```

Click subscribe at the bottom of this page.

```
https://api.portal.trustedservices.intel.com/products#product=liv-intel-software-guard-extensions-provisioning-certification-service
```

Copy the primary key, this is `<PCS_KEY>` and step 9 needs it.

## 4. Set up SSH config and connect

Open SSH config:

```bash
code ~/.ssh/config
```

Paste this replacing the server IP:

```text
Host tdx
    HostName <SERVER_IP>
    User ubuntu
    IdentityFile ~/.ssh/tdx-ssh
    IdentitiesOnly yes
    AddKeysToAgent yes
    UseKeychain yes
    ServerAliveInterval 30
    ServerAliveCountMax 6
    TCPKeepAlive yes
```

SSH into the server:

```bash
ssh tdx
```

## 5. Run these commands to confirm set up is correct

```bash
lsb_release -rs                                            # expect 24.04
sudo dmidecode -t 17 | grep -cE "^[[:space:]]+Size: [0-9]" # expect 8 for one socket, 16 for two
sudo apt-get install -y msr-tools && sudo modprobe msr
sudo rdmsr -d -f 63:32 0x87                                # TDX private KeyIDs — expect > 0
sudo journalctl -k -b | grep -i sgx                        # expect an "EPC section", not "zero EPC sections"
```

If any of these are not as expected this likely requires a support ticket to change
the BIOS. 

## 6. Clone canonical tdx and check the BIOS

```bash
cd ~
git clone https://github.com/canonical/tdx.git
cd ~/tdx
git checkout 9023cb2d952f5fe9d72004092b93a155482ba18a
```

Do this before the host setup. It is all BIOS and a bad result means a support ticket.

```bash
cd ~/tdx/attestation
sudo ./check-production.sh
```

Should emit something like:

```text
CPU: <Emerald Rapids | Sierra Forest>
Production
SGX_DEBUG_MODE=0x0
```

Then 

```bash
sudo ~/tdx/system-report.sh | grep -E "SEAM_RR|SGX_AND_MCHECK"
```

Should give:

```text
SEAM_RR bit: 1 (expected value: 1)
SGX_AND_MCHECK_STATUS: 0 (expected value: 0)
```

## 7. Set up the TDX host and verify

```bash
cd ~/tdx
```

Turn on attestation by editing the config:

```bash
sed -i 's/^TDX_SETUP_ATTESTATION=0/TDX_SETUP_ATTESTATION=1/' setup-tdx-config

grep TDX_SETUP_ATTESTATION setup-tdx-config   # expect =1

sudo ./setup-tdx-host.sh

sudo reboot
```

Then SSH back in after it has rebooted. 

Helper to check when it is back:

```bash
sleep 60; until ssh -o BatchMode=yes -o ConnectTimeout=5 tdx true 2>/dev/null; do sleep 5; done; echo "UP"
```

Then run:

```bash
sudo journalctl -k -b | grep "virt/tdx"
```

Should give:

```text
virt/tdx: module initialized
```

Then run:

```bash
ls -l /dev/sgx_*
```

Should give:

```text
crw-rw---- 1 root sgx     10, 125 Aug 17 07:23 /dev/sgx_enclave
crw-rw---- 1 root sgx_prv 10, 126 Aug 17 07:23 /dev/sgx_provision
crw-rw---- 1 root sgx     10, 124 Aug 17 07:23 /dev/sgx_vepc
```

## 8. Check QEMU version and qgsd and PCCS

```bash
qemu-system-x86_64 --version
```

Should give:

```text
QEMU emulator version 8.2.2 (Debian 2:8.2.2+ds-0ubuntu1.4+tdx1.1)
```

The 8.2.2 is what matters, the Debian suffix will differ.

```bash
systemctl is-active qgsd pccs
```

Should give, one line per unit:

```text
active
active
```

If not active you need to complete part 2.

**Part 2** — install them.

```bash
sudo add-apt-repository -y ppa:kobuk-team/tdx-attestation-release
sudo apt update
sudo apt install -y sgx-dcap-pccs tdx-qgs libsgx-dcap-default-qpl sgx-ra-service sgx-pck-id-retrieval-tool
```

## 9. Configure PCCS with your PCS key

Run it from the PCCS directory. The HTTPS key it generates at the last prompt goes to
`ssl_key/` relative to the working directory, and PCCS only ever reads
`/opt/intel/sgx-dcap-pccs/ssl_key`. Run from your home directory the key lands where
PCCS never looks and it keeps serving the one the package shipped.

```bash
cd /opt/intel/sgx-dcap-pccs && sudo /usr/bin/pccs-configure
```

It prompts for each of these, in this order. Admin comes before user, and getting them
the wrong way round only shows up in step 10 as a rejected user_token.

- Select local connections only
- Paste `<PCS_KEY>` from step 3
- Select LAZY as the caching fill method
- Set a PCCS admin password, twice
- Set a PCCS user password, twice, this is `<PCCS_PASSWORD>` and step 10 needs it
- Select Y to generate an insecure HTTPS key
- Press enter through the nine openssl fields, blank is fine for all of them

## 10. Register the platform and push it to PCCS

```bash
sudo mpa_manage -get_registration_status
```

Should print:

```text
Registration process completed successfully.
```

`user_token` is the PCCS user password from step 9. Type it at the prompt, don't put it
in the command, sudo logs every command line to the journal and it stays there.

```bash
sudo systemctl restart pccs

read -rs t
sudo sh -c 'IFS= read -r t; PCKIDRetrievalTool -url https://localhost:8081 -user_token "$t" -use_secure_cert false' <<<"$t"
```

Should print:

```text
the data has been sent to cache server successfully!
```

Check PCCS reached Intel. This is the only place a bad API key shows up.

```bash
sudo journalctl -u pccs | grep "POST /sgx/certification/v4/platforms"   # expect 200
```

## 11. Install the dstack deps and create the shade user

### 11a. apt packages

```bash
sudo apt update

sudo apt install -y build-essential docker.io docker-compose-v2 docker-buildx jq sqlite3 python3-pip unzip openssl
```

### 11b. The shade user

Everything from here down runs as shade, an unprivileged account that owns the VMM,
the CVMs and their disks. It needs the docker group for the key provider in step 18,
which is why the apt install comes first, that is what creates the group. It needs kvm
too, that is the group on /dev/kvm and QEMU runs as shade:

```bash
sudo useradd -m -s /bin/bash shade
sudo usermod -aG docker,kvm shade
sudo mkdir -p /opt/shade
sudo chown shade:shade /opt/shade
```

Check:

```bash
id -nG shade
```

Should give:

```text
shade kvm docker
```

### 11c. Python deps for vmm-cli

```bash
sudo -u shade pip3 install --user --break-system-packages eth-keys eth-utils "eth-hash[pycryptodome]"
```

```bash
sudo -u shade python3 -c 'from eth_utils import keccak; print(keccak(b"x").hex()[:8])'
```

## 12. Freeze updates that affect measurements

Stop apt auto restarting services. A dockerd or QEMU restart bounces the CVMs.

```bash
sudo mkdir -p /etc/needrestart/conf.d
printf "\$nrconf{restart} = 'l';\n" | sudo tee /etc/needrestart/conf.d/50-no-auto-restart.conf
```

Freeze updates so it doesn't break measurements:

```bash
sudo apt-mark hold containerd docker.io ipxe-qemu libslirp0 libvirt-daemon-driver-qemu qemu-system-common qemu-system-data qemu-system-x86 qemu-utils

apt-mark showhold   # expect 9
```

## 13. Become shade and install rust

```bash
sudo -u shade -i
cd /opt/shade
```

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source ~/.cargo/env
```

And confirm installed:

```bash
rustup show
cargo --version
```

## 14. Build dstack-vmm

```bash
cd /opt/shade

git clone https://github.com/Dstack-TEE/dstack
cd /opt/shade/dstack
git checkout 368c62e7de5d4016bd75332824aa7f2ef1d7d19e # dstack v0.5.8
```

```bash
cargo build --release -p dstack-vmm -p supervisor
```


```bash
mkdir -p /opt/shade/dstack/vmm-data
cp /opt/shade/dstack/target/release/dstack-vmm /opt/shade/dstack/vmm-data/
cp /opt/shade/dstack/target/release/supervisor /opt/shade/dstack/vmm-data/
```

```bash
ls -l /opt/shade/dstack/vmm-data
```

Should give the two binaries, executable and owned by shade:

```text
-rwxrwxr-x 1 shade shade 18913112 Aug 18 06:03 dstack-vmm
-rwxrwxr-x 1 shade shade  8938264 Aug 18 06:03 supervisor
```

## 15. Create the VMM config and the KMS hostname

### 15a. The config file

Make this file on your own computer. Replace `<DOMAIN>` with your domain.

**vmm.toml**

```toml
address = "127.0.0.1"
port = 10000
reuse = true
image_path = "./images"
run_path = "./run/vm"

[cvm]
kms_urls = ["https://kms.internal:11001"]
gateway_urls = ["https://gateway.shade.<DOMAIN>:9202"]
cid_start = 30000
cid_pool_size = 1000
max_disk_size = 100

[cvm.port_mapping]
enabled = true
address = "127.0.0.1"
range = [
    { protocol = "tcp", from = 1, to = 30000 },
    { protocol = "udp", from = 1, to = 30000 },
]

[gateway]
base_domain = "shade.<DOMAIN>"
port = 443
agent_port = 8090

[host_api]
address = "vsock:2"
port = 9300
```

Then copy it to the server (not whilst SSH'd in):

```bash
ssh tdx 'sudo -u shade sh -c "umask 022; cat > /opt/shade/dstack/vmm-data/vmm.toml"' < vmm.toml
```

Check it landed:

```bash
ssh tdx 'wc -l /opt/shade/dstack/vmm-data/vmm.toml; tail -3 /opt/shade/dstack/vmm-data/vmm.toml'
```

### 15b. Give the KMS a name CVMs can resolve

Gives every CVM a name for the KMS off the host's own hosts file, no public DNS
needed. Write both, cloud-init rebuilds /etc/hosts on every boot.

```bash
ssh tdx 'printf "\n# KMS as seen from inside a CVM guest\n10.0.2.2 kms.internal\n" | sudo tee -a /etc/cloud/templates/hosts.debian.tmpl >/dev/null'
ssh tdx 'printf "\n# KMS as seen from inside a CVM guest\n10.0.2.2 kms.internal\n" | sudo tee -a /etc/hosts >/dev/null'
```

Check the stub answers for it, not just the file:

```bash
ssh tdx 'dig @127.0.0.53 +short kms.internal'
```

Should give:

```text
10.0.2.2
```

## 16. Download the guest OS images

### 16a. Download

```bash
cd /opt/shade/dstack/vmm-data

DSTACK_VERSION=0.5.8
wget "https://github.com/Dstack-TEE/meta-dstack/releases/download/v${DSTACK_VERSION}/dstack-${DSTACK_VERSION}.tar.gz"
mkdir -p /opt/shade/dstack/vmm-data/images
tar -xvf dstack-${DSTACK_VERSION}.tar.gz -C /opt/shade/dstack/vmm-data/images/
rm -f dstack-${DSTACK_VERSION}.tar.gz
```

### 16b. Verify the image

```bash
cd /opt/shade/dstack/vmm-data/images/dstack-0.5.8
```

```bash
# 1. File hashes
declare -A EXPECTED
EXPECTED["ovmf.fd"]="76888ce69c91aed86c43f840b913899b40b981964b7ce6018667f91ad06301f0"
EXPECTED["bzImage"]="2afe5b0571363fe2278a3438e337630bfeffc74bafba3d116630e2a1ef1805f3"
EXPECTED["initramfs.cpio.gz"]="1272ab4b10db1933d02a80059fbb94b4be9eb4af8c4f79e739dfc0b0101acc40"
EXPECTED["metadata.json"]="20fde70b9e4f31ab6ef55d8a5bf33b1734593a9e605982c510c0963d69af075b"
for F in "${!EXPECTED[@]}"; do
  H=$(sha256sum "$F" | awk '{print $1}')
  [[ "$H" == "${EXPECTED[$F]}" ]] && echo "$F: OK" || echo "$F: FAILED ($H)"
done

# 2. rootfs dm-verity
META=metadata.json
ROOTFS=$(jq -r '.rootfs' "$META")
ROOTFS_SIZE=$(jq -r '.cmdline' "$META" | sed -n 's/.*dstack.rootfs_size=\([0-9]*\).*/\1/p')
ROOTFS_HASH=$(jq -r '.cmdline' "$META" | sed -n 's/.*dstack.rootfs_hash=\([a-f0-9]*\).*/\1/p')
veritysetup verify --data-blocks=$((ROOTFS_SIZE/4096)) --hash-offset=$ROOTFS_SIZE \
  --data-block-size=4096 --hash-block-size=4096 "$ROOTFS" "$ROOTFS" "$ROOTFS_HASH"
```

## 17. Create the VMM service file

Make this file on your own computer.

**dstack-vmm.service**

```ini
[Unit]
Description=Daemon for dstack-vmm
After=network-online.target docker.service

[Service]
Type=simple
WorkingDirectory=/opt/shade/dstack/vmm-data
ExecStart=/opt/shade/dstack/vmm-data/dstack-vmm -c vmm.toml
Restart=on-failure
RestartSec=5
User=shade
Group=shade

[Install]
WantedBy=multi-user.target
```

Copy it over:

```bash
ssh tdx 'sudo sh -c "umask 022; cat > /etc/systemd/system/dstack-vmm.service"' < dstack-vmm.service
```

Start it:

```bash
ssh tdx 'sudo loginctl enable-linger shade'
ssh tdx 'sudo systemctl daemon-reload && sudo systemctl enable --now dstack-vmm'
```

Check:

```bash
ssh tdx 'systemctl is-active dstack-vmm; ss -ltnp | grep 10000'
```

Should give:

```text
active
```

## 18. Set up gramine sealing key provider (needed for the KMS)

Only the key-provider build files come from 0.5.11, everything else stays on 0.5.8.

```bash
cd /opt/shade/dstack
git worktree add /opt/shade/dstack-v0.5.11 v0.5.11
```

### 18a. Point it at your own PCCS

It ships pointing at Phala's public one, which would put an external service on the
path of your CVM disk key.

Make this file on your own computer.

**sgx_default_qcnl.conf**

```json
{
  "pccs_url": "https://localhost:8081/sgx/certification/v4/",
  "use_secure_cert": false,
  "retry_times": 6,
  "retry_delay": 10,
  "pck_cache_expire_hours": 168,
  "verify_collateral_cache_expire_hours": 168,
  "local_cache_only": false
}
```

Copy it over:

```bash
ssh tdx 'sudo -u shade sh -c "umask 022; cat > /opt/shade/dstack-v0.5.11/key-provider-build/sgx_default_qcnl.conf"' < sgx_default_qcnl.conf
```

### 18b. Build it, from inside SSH

```bash
cd /opt/shade/dstack-v0.5.11/key-provider-build
APT_SNAPSHOT=20260423T000000Z ./run.sh
```

Check both containers are up, not restarting:

```bash
docker ps --filter name=aesmd --filter name=gramine-sealing-key-provider --format 'table {{.Names}}\t{{.Status}}'
```

### 18c. Check it is listening

```bash
docker logs gramine-sealing-key-provider 2>&1 | grep -E "PRODUCTION|Listening|ERROR"
```

Should give, with no ERROR lines:

```text
Running in PRODUCTION mode - full security enabled
Listening on 0.0.0.0:3443
```

### 18d. Get the mr_enclave

```bash
docker logs gramine-sealing-key-provider 2>&1 | grep mr_enclave | head -1
```

Should give:

```text
6b5ed02e549a1c30aaa8e3171a045f1f449b0017353ef595e78e39c348c98d01
```

## 19. Deploy the KMS as a CVM

### 19a. Serve the guest image from the host

This rebuilds the OS image, the way the KMS expects, in a directory the
web server can serve. The KMS downloads it to verify an app's image before giving out keys, and GitHub's nested layout fails that check, so the CVM just reboots in a loop.

```bash
ssh tdx 'sudo -u shade mkdir -p /opt/shade/imgsrv && sudo -u shade tar -czf /opt/shade/imgsrv/dstack-0.5.8.tar.gz -C /opt/shade/dstack/vmm-data/images/dstack-0.5.8 sha256sum.txt ovmf.fd bzImage initramfs.cpio.gz metadata.json && ls -lh /opt/shade/imgsrv/'
```

Serve the OS tarball on a loopback so the KMS can verify apps against it. Make this file on your own computer.

**shade-imgsrv.service**

```ini
[Unit]
Description=KMS guest image server
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 -m http.server 11008 --bind 127.0.0.1 --directory /opt/shade/imgsrv
Restart=on-failure
RestartSec=5
User=shade
Group=shade

[Install]
WantedBy=multi-user.target
```

```bash
ssh tdx 'sudo sh -c "umask 022; cat > /etc/systemd/system/shade-imgsrv.service"' < shade-imgsrv.service

ssh tdx 'sudo systemctl daemon-reload && sudo systemctl enable --now shade-imgsrv'
ssh tdx 'curl -sI http://127.0.0.1:11008/dstack-0.5.8.tar.gz | head -1'
```

Should give:

```text
200 OK
```

### 19b. Install bun

auth-simple runs on bun. Install it as shade:

```bash
sudo -u shade -i

cd ~
curl -fsSL https://bun.sh/install | bash
~/.bun/bin/bun --version
```

### 19c. Install auth-simple deps and bind it to loopback

Still as shade user run:

```bash
cd /opt/shade/dstack/kms/auth-simple
~/.bun/bin/bun install
```

Stop auth-simple listening on the public IP, still shade:

```bash
grep -q 'hostname:' index.ts || sed -i 's#^  fetch: app.fetch,#  hostname: process.env.HOST || "127.0.0.1",\n  fetch: app.fetch,#' index.ts
```

### 19d. Write the allowlist

Still as shade allow list the OS image:

```bash
mkdir -p /opt/shade/kms
OS_HASH="0x$(cat /opt/shade/dstack/vmm-data/images/dstack-0.5.8/digest.txt)"
cat > /opt/shade/kms/auth-config.json <<JSON
{
  "osImages": ["$OS_HASH"],
  "kms": { "allowAnyDevice": true },
  "apps": {}
}
JSON
```

Check it:

```bash
cat /opt/shade/kms/auth-config.json
```

### 19e. Run auth-simple as a service

The rest of this step runs on your own computer, not SSH'd in.

Run auth-simple as a service so it survives a reboot. Make this file on your own
computer.

**shade-kms-auth.service**

```ini
[Unit]
Description=KMS auth-simple webhook
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/shade/dstack/kms/auth-simple
Environment=PORT=3001
Environment=HOST=127.0.0.1
Environment=AUTH_CONFIG_PATH=/opt/shade/kms/auth-config.json
ExecStart=/home/shade/.bun/bin/bun run index.ts
Restart=on-failure
RestartSec=5
User=shade
Group=shade

[Install]
WantedBy=multi-user.target
```

Copy it over:

```bash
ssh tdx 'sudo sh -c "umask 022; cat > /etc/systemd/system/shade-kms-auth.service"' < shade-kms-auth.service
```

Start it:

```bash
ssh tdx 'sudo systemctl daemon-reload && sudo systemctl enable --now shade-kms-auth'
ssh tdx 'systemctl is-active shade-kms-auth'
```

Should give:

```text
active
```

### 19f. Make the KMS env file

Make this file on your own computer. `<ADMIN_TOKEN>` comes from the command below
the file.

**env.simple**

```ini
VMM_RPC=http://127.0.0.1:10000
AUTH_WEBHOOK_URL=http://10.0.2.2:3001
KMS_RPC_ADDR=127.0.0.1:11001
GUEST_AGENT_ADDR=127.0.0.1:11005
IMAGE_DOWNLOAD_URL=http://10.0.2.2:11008/dstack-0.5.8.tar.gz
VERIFY_IMAGE=true
OS_IMAGE=dstack-0.5.8
KMS_IMAGE=dstacktee/dstack-kms@sha256:9650dcb47dad0065470f432f00e78e012912214ef1a5b1d7272918817e61a26d
ADMIN_TOKEN=<ADMIN_TOKEN>
```

Generate the token and paste it over `<ADMIN_TOKEN>`, make sure you record this:

```bash
openssl rand -hex 16
```

Copy it over, 600 because of the token.

```bash
ssh tdx 'sudo -u shade sh -c "rm -f /opt/shade/dstack/kms/dstack-app/.env.simple; umask 077; cat > /opt/shade/dstack/kms/dstack-app/.env.simple"' < env.simple
```

Check:

```bash
ssh tdx 'ls -l /opt/shade/dstack/kms/dstack-app/.env.simple'
ssh tdx 'sudo -u shade grep -c . /opt/shade/dstack/kms/dstack-app/.env.simple'
```

Should be `-rw-------` and 9.

### 19g. Deploy it

SSH in as ubuntu and become shade. 

```bash
sudo -u shade -i
cd /opt/shade/dstack/kms/dstack-app
./deploy-simple.sh
```

Note the VM id, the next command needs it.

Watch it boot, replacing the VM ID:

```bash
ssh tdx 'sudo tail -f /opt/shade/dstack/vmm-data/run/vm/<VM_ID>/serial.log'
```

Wait for:

```text
[  OK  ] Finished App Compose Service.
```

If the VMM keeps restarting the CVM and serial.log is empty, QEMU never started, so it
is a host problem and not the allowlist. The reason is in stderr.log next to it.

```bash
sudo tail /opt/shade/dstack/vmm-data/run/vm/<VM_ID>/stderr.log
```

### 19h. Bootstrap the KMS

```bash
curl -s -X POST 'http://127.0.0.1:11001/prpc/Onboard.Bootstrap?json' -H 'Content-Type: application/json' --data '{"domain":"kms.internal"}'
curl -s -X POST 'http://127.0.0.1:11001/prpc/Onboard.Finish?json' -H 'Content-Type: application/json' --data '{}'
```

Check:

```bash
curl -sk -X POST 'https://127.0.0.1:11001/prpc/GetMeta?json' -H 'Content-Type: application/json' --data '{}'
```

Should give JSON.

Never delete a healthy KMS CVM. Its sealed root key and every app key derived from
it go with it.

## 20. Deploy the gateway as a CVM

### 20a. Allowlist it in auth-simple

Do this before deploying it or it won't boot. An app that isn't in auth-config.json
gets denied keys. Generate an app id for it:

```bash
openssl rand -hex 20
```

Get the OS image hash off the box:

```bash
ssh tdx 'sudo -u shade cat /opt/shade/dstack/vmm-data/images/dstack-0.5.8/digest.txt'
```

Make this file on your own computer. Replace `<OS_IMAGE_HASH>` and
`<GATEWAY_APP_ID>` twice with the two values above, keeping the 0x on both. K

**auth-config.json**

```json
{
  "osImages": ["0x<OS_IMAGE_HASH>"],
  "kms": { "allowAnyDevice": true },
  "gatewayAppId": "0x<GATEWAY_APP_ID>",
  "apps": {
    "0x<GATEWAY_APP_ID>": {
      "composeHashes": [],
      "devices": [],
      "allowAnyDevice": true
    }
  }
}
```

Check it parses. auth-simple won't start on bad JSON, and then every boot gets denied.

```bash
jq . auth-config.json
```

Copy it over:

```bash
ssh tdx 'sudo -u shade sh -c "umask 022; cat > /opt/shade/kms/auth-config.json"' < auth-config.json

ssh tdx 'sudo systemctl restart shade-kms-auth'
ssh tdx 'systemctl is-active shade-kms-auth'
```

Should give:

```text
active
```

### 20b. Make the gateway env file

Make this file on your own computer. Replace `<CF_API_TOKEN>`, `<DOMAIN>`,
`<SERVER_IP>` and the gateway app id from 20a, raw hex with no 0x this time.
`<LAUNCH_TOKEN>` comes from the command below the file.

**gw.env**

```ini
VMM_RPC=http://127.0.0.1:10000
KMS_URL=https://127.0.0.1:11001
KMS_URL_GUEST=https://kms.internal:11001
CF_API_TOKEN=<CF_API_TOKEN>
SRV_DOMAIN=shade.<DOMAIN>
PUBLIC_IP=<SERVER_IP>
GATEWAY_APP_ID=<gwappid, raw hex, no 0x>
MY_URL=https://gateway.shade.<DOMAIN>:9202
BOOTNODE_URL=https://gateway.shade.<DOMAIN>:9202
NET_MODE=user
WG_ADDR=0.0.0.0:9202
GATEWAY_RPC_ADDR=0.0.0.0:9202
GATEWAY_ADMIN_RPC_ADDR=127.0.0.1:9203
GATEWAY_SERVING_PORT=443
GATEWAY_SERVING_NUM_PORTS=1
GUEST_AGENT_ADDR=127.0.0.1:9206
NODE_ID=1
SUBNET_INDEX=0
ACME_STAGING=no
OS_IMAGE=dstack-0.5.8
GATEWAY_IMAGE=dstacktee/dstack-gateway@sha256:6eb1dc1a5000f37cc5b0322d3fdb71e7f2e31859b5e3a611634919278cee2411
APP_LAUNCH_TOKEN=<LAUNCH_TOKEN>
```

Generate the launch token and paste it over `<LAUNCH_TOKEN>`, make sure you record this:

```bash
openssl rand -hex 16
```

### 20c. Patch the deploy script for the second KMS URL

`--kms-url` is read twice, by `vmm-cli` on the host and by the guest, and neither
URL works for both: the host can't reach kms.internal, the guest can't reach
127.0.0.1. The script only passes one, so patch the second in.

```bash
ssh tdx 'sudo -u shade python3 -' <<'PY'
p = "/opt/shade/dstack/gateway/dstack-app/deploy-to-vmm.sh"
s = open(p).read()
old = '  --kms-url "$KMS_URL"\n'
new = old + '  --kms-url "${KMS_URL_GUEST:-$KMS_URL}"\n'
if "KMS_URL_GUEST" in s:
    print("already patched")
else:
    assert s.count(old) == 1, s.count(old)
    open(p, "w").write(s.replace(old, new))
    print("patched")
PY
```

Check it:

```bash
ssh tdx 'grep -n kms-url /opt/shade/dstack/gateway/dstack-app/deploy-to-vmm.sh'
```

Should give:

```text
--kms-url "$KMS_URL"
--kms-url "${KMS_URL_GUEST:-$KMS_URL}"
```

Copy it over:

```bash
ssh tdx 'sudo -u shade sh -c "rm -f /opt/shade/dstack/gateway/dstack-app/.env; umask 077; cat > /opt/shade/dstack/gateway/dstack-app/.env"' < gw.env
```

### 20d. Let QEMU bind 443

QEMU needs cap_net_bind_service or it can't bind 443, and the CVM dies on start. Let Qemu bind to 443:

```bash
ssh tdx 'sudo setcap "cap_net_bind_service=+ep" $(which qemu-system-x86_64)'
ssh tdx 'getcap /usr/bin/qemu-system-x86_64'
```

An apt upgrade of QEMU drops the cap and the gateway stops binding 443, so recheck
it after any update that touches QEMU.

### 20e. Stop the host caching DNS misses

The wildcard cert in step 20g comes over DNS-01, writing a TXT record to Cloudflare
then polling for it. The first poll misses, and 8.8.8.8 caches that
miss for 1800s, longer than the cert request lives. Point the resolver at
Cloudflare, which serves the zone, and stop it caching misses:

```bash
printf '[Resolve]\nDNS=1.1.1.1\nCache=no-negative\n' > acme-dns.conf

ssh tdx 'sudo sh -c "umask 022; mkdir -p /etc/systemd/resolved.conf.d && cat > /etc/systemd/resolved.conf.d/acme-dns.conf"' < acme-dns.conf
ssh tdx 'sudo systemctl restart systemd-resolved'
```

### 20f. Deploy it

Check shade can actually hash first:

```bash
ssh tdx 'sudo -u shade python3 -c "from eth_utils import keccak; print(keccak(b\"x\").hex()[:8])"'
```

Then deploy. SSH in and become shade.

```bash
ssh tdx
sudo -u shade -i
cd /opt/shade/dstack/gateway/dstack-app
./deploy-to-vmm.sh
```

It prints a `Compose hash: 0x...` line, then stops at `Continue? [y/N]`. Leave it
sitting there, the CVM boot-loops if the hash isn't allowlisted before it starts.

### IMPORTANT

### Paste the hash into composeHashes in your local auth-config.json, keeping the 0x.

then in another terminal:

```bash
jq . auth-config.json

ssh tdx 'sudo -u shade sh -c "umask 022; cat > /opt/shade/kms/auth-config.json"' < auth-config.json

ssh tdx 'sudo systemctl restart shade-kms-auth'
ssh tdx 'systemctl is-active shade-kms-auth'
```

Now press y.

Watch it boot.

```bash
ssh tdx 'sudo tail -f /opt/shade/dstack/vmm-data/run/vm/<VM_ID>/serial.log'
```

The script has no `set -e`, so if it errors it carries on to `Waiting for gateway
admin API` and hangs there forever. Ctrl-C it, fix, rerun.

Every failed attempt leaves a VM behind that the VMM keeps restarting, and they
fight over 443 and 9202. Remove the dead ones before retrying.

```bash
C="sudo -u shade python3 /opt/shade/dstack/vmm/src/vmm-cli.py --url http://127.0.0.1:10000"
$C lsvm
$C stop <VM_ID>; $C remove <VM_ID>
```

### 20g. Check the gateway got its cert

Poll until `has_cert` and `loaded_in_memory` are both true. With step 20e's resolver in
place it lands in seconds.

```bash
ssh tdx "curl -s -X POST 'http://127.0.0.1:9203/prpc/ListZtDomains?json' -H 'Content-Type: application/json' -d '{}' | jq '.domains[].cert_status'"
```

### 20h. Check

The Status probe is the one the deploy script waits on, so JSON back means the guest
booted, got its keys, and the gateway is serving. hosts fills in as CVMs register.

```bash
ssh tdx 'curl -s "http://127.0.0.1:9203/prpc/Status?json" | jq "{num_connections, hosts}"'
ssh tdx 'journalctl -u shade-kms-auth --no-pager'
```

Don't probe 9202 with curl, it is RA-TLS and always gives 000. Testing 443 needs a real
`<APP_ID>-<port>` hostname, the gateway closes anything else.

## 21. Restrict inbound to SSH and the gateway ports

### 21a. Arm a safety net first

Enabling a default deny firewall over the SSH you are using can lock you out. This
disables ufw again in 5 minutes unless you cancel it.

```bash
ssh tdx 'sudo nohup sh -c "sleep 300; ufw --force disable" >/dev/null 2>&1 & echo armed'
```

Run 21b from an SSH session you keep open, you fix things from it if the rules are
wrong.

### 21b. Add the rules

As ubuntu:

```bash
sudo ufw allow 22/tcp
sudo ufw allow 443/tcp
sudo ufw allow 9202/tcp
sudo ufw allow 9202/udp
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw --force enable
```

### 21c. Prove you aren't locked out

ufw never drops an established connection, so the session you enabled it from
survives even if allow 22 is broken. Only a fresh one tests the rule. From a second
terminal:

```bash
ssh tdx 'echo ok'
```

`ok` means you're fine. Now cancel the timer, matching on something that isn't in
your own command line. `pkill -f "sleep 300"` matches the shell running it and kills
your own session, SSH exits 255.

```bash
ssh tdx 'sudo pkill -f "force disab""le"'
ssh tdx 'sudo ufw status verbose'
```

Status active, and you're done. Inactive means the timer fired first and pkill
killed nothing, it exits quietly either way. Only then, the rules are still on disk
so put it back with:

```bash
ssh tdx 'sudo ufw --force enable'
```

## 22. Delete the local copies

The server has every file now, and the env ones hold live secrets you can't rotate.
Delete them from your own computer.

```bash
rm -f vmm.toml dstack-vmm.service sgx_default_qcnl.conf shade-imgsrv.service \
  shade-kms-auth.service env.simple gw.env acme-dns.conf auth-config.json
```

Check they are gone, and that none of them ever got committed:

```bash
ls -a env.simple gw.env vmm.toml auth-config.json 2>/dev/null
git log --all --oneline -- env.simple gw.env auth-config.json | head
```

Both should give nothing at all.

## 23. Get this box's PPID and key provider digest (Optional)

For a given app compose, dstack image and virtual hardware settings (e.g. tdx.small = 1VCPU 2GB RAM) launching an application on Phala and Dstack will have identical measurements apart from the key provider digest since the KMS CVM being used is different and the PPID since it's running on different hardware.

### 23a. Get the PPID

Pull the certs down:

```bash
ssh tdx 'sudo sqlite3 /opt/intel/sgx-dcap-pccs/pckcache.db "select distinct pck_cert from pck_cert;"' > pck.pem
```

Then read the PPID out. The heredoc end marker has to be at the start of the line.

```bash
python3 - <<'PY'
import base64, re
data = open("pck.pem").read()
certs = re.findall(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", data, re.S)
OID = bytes.fromhex("060a2a864886f84d010d0101")
found = set()
for c in certs:
    der = base64.b64decode("".join(l for l in c.splitlines() if "CERTIFICATE" not in l))
    i = der.find(OID)
    if i < 0: continue
    j = i + len(OID)
    if der[j] == 0x04:
        found.add(der[j+2 : j+2+der[j+1]].hex())
for x in found:
    print("ppid:", x, f"({len(x)//2} bytes)")
PY
```

Should print one 16 byte value. There are several cached certs, one per TCB level,
but they all carry the same PPID so a single line out is correct.

### 23b. Get the key provider digest

For Phala KMS the key-provider event digest has payload
`{"name":"kms","id":"<hex der spki of the kms root ca pubkey>"}` and the digest is: 

```text
sha384(u32le(0x08000001) || ":" || "key-provider" || ":" || payload)
```

Pull the root CA and its pubkey:

```bash
ssh tdx 'curl -sk -m 10 https://127.0.0.1:11001/prpc/KMS.GetMeta' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["ca_cert"],end="")' > kms-ca.pem

openssl x509 -in kms-ca.pem -pubkey -noout \
  | openssl pkey -pubin -outform DER | xxd -p -c 999 > spki.hex
```

Then hash it to get the digest:

```bash
python3 - <<'PY'
import hashlib, json, struct
spki = open("spki.hex").read().strip()
payload = json.dumps({"name": "kms", "id": spki}, separators=(",", ":")).encode()
blob = struct.pack("<I", 0x08000001) + b":key-provider:" + payload
print("key_provider_event_digest:", hashlib.sha384(blob).hexdigest())
PY
```

## 24. Deploy the agent

Everything the box needs is in place. Deploy the agent itself with shade-agent-cli,
it builds the app compose, allowlists the hashes and deploys the CVM for you.

See [example-11.yaml](../../shade-agent-cli/example-deployment-files/example-11.yaml) for a `deployment.yaml` for this target.

## Managing the CVMs

Not a step, come back to this when you need it.

### Reading the logs

The VMM console covers every CVM. You can see logs, info and manage cvms here. Forward this page to your local computer:

```bash
ssh -fN -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 10000:127.0.0.1:10000 tdx
```

Open

```txt
http://127.0.0.1:10000
```

And to close it:

```bash
pkill -f "L 10000:127.0.0.1:10000"
```

### Revoking an app in the KMS

While you can delete apps in the vmm dashboard you can't remove the app ID from being approved in the KMS, you must do this manually. 
If you deleted your local copy of auth-config.json, pull the live one back first.

```bash
ssh tdx 'sudo -u shade cat /opt/shade/kms/auth-config.json' > auth-config.json
```

Take the hash out of composeHashes for that app, or drop the whole app entry, then
copy it back.

```bash
jq . auth-config.json

ssh tdx 'sudo -u shade sh -c "umask 022; cat > /opt/shade/kms/auth-config.json"' < auth-config.json
```

### Single tenant only

This setup is for running agents you control, and nothing else. Every CVM on the
box can reach the host's loopback services and every other CVM's forwarded ports,
so one CVM can read another CVM's console logs off the VMM, and create, stop or
delete CVMs, because the VMM API on port 10000 has no authentication. Treat a compromised agent as a compromised sever.

If you want to host many CVMs, or run workloads from actors you don't trust, this will require additional setup

### Maintaining the Server and TCB

TODO

### Recovering KMS 

TODO