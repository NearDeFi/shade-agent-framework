import crypto from "crypto";
import fs from "fs";
import { parse } from "yaml";

export function getMeasurements(isTee, dockerComposePath, dstackVersion, instanceType) {
  if (!isTee) {
    return localMeasurements;
  }

  if (!dockerComposePath) {
    throw new Error(
      "dockerComposePath is required when isTee is true",
    );
  }

  if (!dstackVersion || !instanceType) {
    throw new Error(
      "dstack_version and instance_type (from deploy_to_phala) are required to calculate TEE measurements",
    );
  }

  return createTeeMeasurements(calculateAppComposeHash(dockerComposePath), dstackVersion, instanceType);
}

function createTeeMeasurements(appComposeHash, dstackVersion, instanceType) {
  const versionMeasurements = hardwareAndOSMeasurements[dstackVersion];
  if (!versionMeasurements) {
    const supported = Object.keys(hardwareAndOSMeasurements).join(", ");
    throw new Error(
      `Unsupported dstack_version "${dstackVersion}". Supported versions: ${supported}`,
    );
  }

  const hwMeasurements = versionMeasurements[instanceType];
  if (!hwMeasurements) {
    const supported = Object.keys(versionMeasurements).join(", ");
    throw new Error(
      `Unsupported instance_type "${instanceType}" for dstack_version "${dstackVersion}". Supported types: ${supported}`,
    );
  }

  return {
    rtmrs: hwMeasurements.rtmrs,
    key_provider_event_digest: KEY_PROVIDER_EVENT_DIGEST,
    app_compose_hash_payload: appComposeHash,
  };
}

// Helper function to extract allowed envs from docker-compose file
export function extractAllowedEnvs(dockerComposePath) {
  const dockerComposeFile = fs.readFileSync(dockerComposePath, "utf8");
  const dockerCompose = parse(dockerComposeFile);
  const allowedEnvs = [];

  // Iterate through all services
  if (dockerCompose.services) {
    for (const serviceName in dockerCompose.services) {
      const service = dockerCompose.services[serviceName];
      if (service.environment) {
        // Handle both object and array formats for environment
        if (
          typeof service.environment === "object" &&
          !Array.isArray(service.environment)
        ) {
          for (const envKey in service.environment) {
            const envValue = service.environment[envKey];
            // Check if the value matches ${VARIABLE_NAME} pattern
            const match =
              envValue &&
              typeof envValue === "string" &&
              envValue.match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/);
            if (match) {
              const varName = match[1];
              if (!allowedEnvs.includes(varName)) {
                allowedEnvs.push(varName);
              }
            }
          }
        }
      }
    }
  }

  return allowedEnvs;
}

/**
 * Build the app compose object used for both measurement hashing and Phala Cloud provision.
 * Must stay in sync so the compose_hash from Phala matches the agent contract's approved measurements.
 *
 * @param {string} dockerComposeFileContent - Raw docker-compose YAML string
 * @param {string[]} allowedEnvs - List of env key names allowed in the CVM
 * @returns {object} App compose object (same shape as used in calculateAppComposeHash)
 */
export function buildAppComposeForDeploy(dockerComposeFileContent, allowedEnvs) {
  return {
    allowed_envs: allowedEnvs,
    docker_compose_file: dockerComposeFileContent,
    features: ["kms", "tproxy-net"],
    gateway_enabled: true,
    kms_enabled: true,
    local_key_provider_enabled: false,
    manifest_version: 2,
    name: "",
    no_instance_id: false,
    pre_launch_script: PRE_LAUNCH_SCRIPT,
    public_logs: true,
    public_sysinfo: true,
    public_tcbinfo: true,
    runner: "docker-compose",
    secure_time: false,
    storage_fs: "zfs",
    tproxy_enabled: true,
  };
}

// Calculate app compose hash with optional allowed envs override
export function calculateAppComposeHash(
  dockerComposePath,
  allowedEnvsOverride = null,
) {
  const dockerComposeFile = fs.readFileSync(dockerComposePath, "utf8");

  // If override is provided, use it; otherwise extract from docker-compose
  const allowedEnvs =
    allowedEnvsOverride !== null
      ? allowedEnvsOverride
      : extractAllowedEnvs(dockerComposePath);

  const appCompose = buildAppComposeForDeploy(dockerComposeFile, allowedEnvs);

  return hashAppCompose(appCompose);
}

// SHA-256 of the canonical JSON encoding of an app-compose object.
// Use directly when you already have the compose object in hand (e.g. mid-deploy
// hash check) instead of re-reading the file via calculateAppComposeHash.
export function hashAppCompose(appCompose) {
  const jsonString = JSON.stringify(appCompose);
  return crypto.createHash("sha256").update(jsonString).digest("hex");
}

const localMeasurements = {
  rtmrs: {
    mrtd: "0".repeat(96),
    rtmr0: "0".repeat(96),
    rtmr1: "0".repeat(96),
    rtmr2: "0".repeat(96),
  },
  key_provider_event_digest: "0".repeat(96),
  app_compose_hash_payload: "0".repeat(64),
};

const KEY_PROVIDER_EVENT_DIGEST =
  "83368b43a0fc6f824f5a9220592df85fd30e2d405ecbd253a5c6354af63e6c9b41aec557c38a38e348ab87f9ac8fc68c";

export const hardwareAndOSMeasurements = {
  "0.5.8": {
    "tdx.small": {
      "rtmrs": {
        "mrtd": "f06dfda6dce1cf904d4e2bab1dc370634cf95cefa2ceb2de2eee127c9382698090d7a4a13e14c536ec6c9c3c8fa87077",
        "rtmr0": "68102e7b524af310f7b7d426ce75481e36c40f5d513a9009c046e9d37e31551f0134d954b496a3357fd61d03f07ffe96",
        "rtmr1": "b598fde9491427341bc4683b75d10d3e36770af3a36a6954d8b6b7b22aa66358f13e1f172e51b7d6e6710d99a8d8532f",
        "rtmr2": "9284cde236231d5ddace01104a440fd504df5182a2ad1ac3d2138b80c6a7864bd2c30f69041d8264217f3d24541580cf"
      }
    },
    "tdx.medium": {
      "rtmrs": {
        "mrtd": "f06dfda6dce1cf904d4e2bab1dc370634cf95cefa2ceb2de2eee127c9382698090d7a4a13e14c536ec6c9c3c8fa87077",
        "rtmr0": "027b610ab0555482f8a3868524093bdf3cdbe2539f81dfeeb886864654cb2fe3422f7fc36d4bab6fa46683aad11d1ba7",
        "rtmr1": "b598fde9491427341bc4683b75d10d3e36770af3a36a6954d8b6b7b22aa66358f13e1f172e51b7d6e6710d99a8d8532f",
        "rtmr2": "9284cde236231d5ddace01104a440fd504df5182a2ad1ac3d2138b80c6a7864bd2c30f69041d8264217f3d24541580cf"
      }
    },
    "tdx.large": {
      "rtmrs": {
        "mrtd": "f06dfda6dce1cf904d4e2bab1dc370634cf95cefa2ceb2de2eee127c9382698090d7a4a13e14c536ec6c9c3c8fa87077",
        "rtmr0": "fb14dc139f33d6fcf474bc8332cac001259fb31cfbcb6b34d4ceeb552a2c4466884a0cbde45ad98a05c5c060c23ad65a",
        "rtmr1": "b598fde9491427341bc4683b75d10d3e36770af3a36a6954d8b6b7b22aa66358f13e1f172e51b7d6e6710d99a8d8532f",
        "rtmr2": "9284cde236231d5ddace01104a440fd504df5182a2ad1ac3d2138b80c6a7864bd2c30f69041d8264217f3d24541580cf"
      }
    },
    "tdx.xlarge": {
      "rtmrs": {
        "mrtd": "f06dfda6dce1cf904d4e2bab1dc370634cf95cefa2ceb2de2eee127c9382698090d7a4a13e14c536ec6c9c3c8fa87077",
        "rtmr0": "ec216f1d1d591468ff4741b9b192f016b26d3f90303bfa9dbb97557273853183981f21a4bcb3ae908247538d371ad072",
        "rtmr1": "b598fde9491427341bc4683b75d10d3e36770af3a36a6954d8b6b7b22aa66358f13e1f172e51b7d6e6710d99a8d8532f",
        "rtmr2": "9284cde236231d5ddace01104a440fd504df5182a2ad1ac3d2138b80c6a7864bd2c30f69041d8264217f3d24541580cf"
      }
    },
    "tdx.2xlarge": {
      "rtmrs": {
        "mrtd": "f06dfda6dce1cf904d4e2bab1dc370634cf95cefa2ceb2de2eee127c9382698090d7a4a13e14c536ec6c9c3c8fa87077",
        "rtmr0": "d6118f0eeb30e9d9178d2b9106dddd002d979b6fa79bdec415051afae2021384c29a32d2f6454fa369617598378ffb5e",
        "rtmr1": "b598fde9491427341bc4683b75d10d3e36770af3a36a6954d8b6b7b22aa66358f13e1f172e51b7d6e6710d99a8d8532f",
        "rtmr2": "9284cde236231d5ddace01104a440fd504df5182a2ad1ac3d2138b80c6a7864bd2c30f69041d8264217f3d24541580cf"
      }
    },
    "tdx.4xlarge": {
      "rtmrs": {
        "mrtd": "f06dfda6dce1cf904d4e2bab1dc370634cf95cefa2ceb2de2eee127c9382698090d7a4a13e14c536ec6c9c3c8fa87077",
        "rtmr0": "55b9b0d73279fd2079274371e639b70161a69447b6b07f7b5266f0b8a47fd1e527fca30338879b47ac18d9bf66022e5c",
        "rtmr1": "b598fde9491427341bc4683b75d10d3e36770af3a36a6954d8b6b7b22aa66358f13e1f172e51b7d6e6710d99a8d8532f",
        "rtmr2": "9284cde236231d5ddace01104a440fd504df5182a2ad1ac3d2138b80c6a7864bd2c30f69041d8264217f3d24541580cf"
      }
    },
    "tdx.8xlarge": {
      "rtmrs": {
        "mrtd": "f06dfda6dce1cf904d4e2bab1dc370634cf95cefa2ceb2de2eee127c9382698090d7a4a13e14c536ec6c9c3c8fa87077",
        "rtmr0": "de03721065571be16e3ccbb76dacdc86a6dfb35255480dfc97932995c5d0973b6f0b6b7b9f8e88b838d72bc75e8a287c",
        "rtmr1": "b598fde9491427341bc4683b75d10d3e36770af3a36a6954d8b6b7b22aa66358f13e1f172e51b7d6e6710d99a8d8532f",
        "rtmr2": "9284cde236231d5ddace01104a440fd504df5182a2ad1ac3d2138b80c6a7864bd2c30f69041d8264217f3d24541580cf"
      }
    }
  },
  "0.5.7": {
    "tdx.small": {
      "rtmrs": {
        "mrtd": "f06dfda6dce1cf904d4e2bab1dc370634cf95cefa2ceb2de2eee127c9382698090d7a4a13e14c536ec6c9c3c8fa87077",
        "rtmr0": "68102e7b524af310f7b7d426ce75481e36c40f5d513a9009c046e9d37e31551f0134d954b496a3357fd61d03f07ffe96",
        "rtmr1": "920eb831509b58bf83a554b5377dd5ce26d3f5182f14d33622ac24c1d343a0fa3c7bde746e55098ca30baf784dfd2556",
        "rtmr2": "4674857a0f5b090f9203245f55c6516c37f533b362576a505f5b89efa2a28376d6b82e984e41f1f0ebcddfcbeb9581b9"
      }
    },
    "tdx.medium": {
      "rtmrs": {
        "mrtd": "f06dfda6dce1cf904d4e2bab1dc370634cf95cefa2ceb2de2eee127c9382698090d7a4a13e14c536ec6c9c3c8fa87077",
        "rtmr0": "027b610ab0555482f8a3868524093bdf3cdbe2539f81dfeeb886864654cb2fe3422f7fc36d4bab6fa46683aad11d1ba7",
        "rtmr1": "920eb831509b58bf83a554b5377dd5ce26d3f5182f14d33622ac24c1d343a0fa3c7bde746e55098ca30baf784dfd2556",
        "rtmr2": "4674857a0f5b090f9203245f55c6516c37f533b362576a505f5b89efa2a28376d6b82e984e41f1f0ebcddfcbeb9581b9"
      }
    },
    "tdx.large": {
      "rtmrs": {
        "mrtd": "f06dfda6dce1cf904d4e2bab1dc370634cf95cefa2ceb2de2eee127c9382698090d7a4a13e14c536ec6c9c3c8fa87077",
        "rtmr0": "fb14dc139f33d6fcf474bc8332cac001259fb31cfbcb6b34d4ceeb552a2c4466884a0cbde45ad98a05c5c060c23ad65a",
        "rtmr1": "920eb831509b58bf83a554b5377dd5ce26d3f5182f14d33622ac24c1d343a0fa3c7bde746e55098ca30baf784dfd2556",
        "rtmr2": "4674857a0f5b090f9203245f55c6516c37f533b362576a505f5b89efa2a28376d6b82e984e41f1f0ebcddfcbeb9581b9"
      }
    },
    "tdx.xlarge": {
      "rtmrs": {
        "mrtd": "f06dfda6dce1cf904d4e2bab1dc370634cf95cefa2ceb2de2eee127c9382698090d7a4a13e14c536ec6c9c3c8fa87077",
        "rtmr0": "ec216f1d1d591468ff4741b9b192f016b26d3f90303bfa9dbb97557273853183981f21a4bcb3ae908247538d371ad072",
        "rtmr1": "920eb831509b58bf83a554b5377dd5ce26d3f5182f14d33622ac24c1d343a0fa3c7bde746e55098ca30baf784dfd2556",
        "rtmr2": "4674857a0f5b090f9203245f55c6516c37f533b362576a505f5b89efa2a28376d6b82e984e41f1f0ebcddfcbeb9581b9"
      }
    },
    "tdx.2xlarge": {
      "rtmrs": {
        "mrtd": "f06dfda6dce1cf904d4e2bab1dc370634cf95cefa2ceb2de2eee127c9382698090d7a4a13e14c536ec6c9c3c8fa87077",
        "rtmr0": "d6118f0eeb30e9d9178d2b9106dddd002d979b6fa79bdec415051afae2021384c29a32d2f6454fa369617598378ffb5e",
        "rtmr1": "920eb831509b58bf83a554b5377dd5ce26d3f5182f14d33622ac24c1d343a0fa3c7bde746e55098ca30baf784dfd2556",
        "rtmr2": "4674857a0f5b090f9203245f55c6516c37f533b362576a505f5b89efa2a28376d6b82e984e41f1f0ebcddfcbeb9581b9"
      }
    },
    "tdx.4xlarge": {
      "rtmrs": {
        "mrtd": "f06dfda6dce1cf904d4e2bab1dc370634cf95cefa2ceb2de2eee127c9382698090d7a4a13e14c536ec6c9c3c8fa87077",
        "rtmr0": "55b9b0d73279fd2079274371e639b70161a69447b6b07f7b5266f0b8a47fd1e527fca30338879b47ac18d9bf66022e5c",
        "rtmr1": "920eb831509b58bf83a554b5377dd5ce26d3f5182f14d33622ac24c1d343a0fa3c7bde746e55098ca30baf784dfd2556",
        "rtmr2": "4674857a0f5b090f9203245f55c6516c37f533b362576a505f5b89efa2a28376d6b82e984e41f1f0ebcddfcbeb9581b9"
      }
    },
    "tdx.8xlarge": {
      "rtmrs": {
        "mrtd": "f06dfda6dce1cf904d4e2bab1dc370634cf95cefa2ceb2de2eee127c9382698090d7a4a13e14c536ec6c9c3c8fa87077",
        "rtmr0": "de03721065571be16e3ccbb76dacdc86a6dfb35255480dfc97932995c5d0973b6f0b6b7b9f8e88b838d72bc75e8a287c",
        "rtmr1": "920eb831509b58bf83a554b5377dd5ce26d3f5182f14d33622ac24c1d343a0fa3c7bde746e55098ca30baf784dfd2556",
        "rtmr2": "4674857a0f5b090f9203245f55c6516c37f533b362576a505f5b89efa2a28376d6b82e984e41f1f0ebcddfcbeb9581b9"
      }
    }
  }
}

const PRE_LAUNCH_SCRIPT = `#!/bin/bash
echo "----------------------------------------------"
echo "Running Phala Cloud Pre-Launch Script v0.0.13"
echo "----------------------------------------------"
set -e

# Function: notify host

notify_host() {
    if command -v dstack-util >/dev/null 2>&1; then
        dstack-util notify-host -e "$1" -d "$2"
    else
        tdxctl notify-host -e "$1" -d "$2"
    fi
}

notify_host_hoot_info() {
    notify_host "boot.progress" "$1"
}

notify_host_hoot_error() {
    notify_host "boot.error" "$1"
}

# Function: Perform Docker cleanup
perform_cleanup() {
    echo "Pruning unused images"
    docker image prune -af
    echo "Pruning unused volumes"
    docker volume prune -f
    notify_host_hoot_info "docker cleanup completed"
}

# Function: Check Docker login status without exposing credentials
check_docker_login() {
    local registry="$1"

    # When registry is specified, check auth entry for that registry in Docker config
    if [[ -n "$registry" ]]; then
        local docker_config_path="\${DOCKER_CONFIG:-$HOME/.docker}/config.json"
        if [[ -f "$docker_config_path" ]] && grep -q "$registry" "$docker_config_path"; then
            return 0
        else
            return 1
        fi
    fi

    # Fallback check when no explicit registry is provided
    if docker info 2>/dev/null | grep -q "Username"; then
        return 0
    else
        return 1
    fi
}

# Main logic starts here
echo "Starting login process..."

# Check if Docker credentials exist
if [[ -n "$DSTACK_DOCKER_USERNAME" && -n "$DSTACK_DOCKER_PASSWORD" ]]; then
    echo "Docker credentials found"
    DOCKER_REGISTRY_TARGET="\${DSTACK_DOCKER_REGISTRY:-docker.io}"
    echo "Target Docker registry: $DOCKER_REGISTRY_TARGET"

    # Check if already logged in
    if check_docker_login "$DSTACK_DOCKER_REGISTRY"; then
        echo "Already logged in to Docker registry: $DOCKER_REGISTRY_TARGET"
    else
        echo "Logging in to Docker registry: $DOCKER_REGISTRY_TARGET"
        # Login without exposing password in process list
        if [[ -n "$DSTACK_DOCKER_REGISTRY" ]]; then
            echo "$DSTACK_DOCKER_PASSWORD" | docker login -u "$DSTACK_DOCKER_USERNAME" --password-stdin "$DSTACK_DOCKER_REGISTRY"
        else
            echo "$DSTACK_DOCKER_PASSWORD" | docker login -u "$DSTACK_DOCKER_USERNAME" --password-stdin
        fi

        if [ $? -eq 0 ]; then
            echo "Docker login successful: $DOCKER_REGISTRY_TARGET"
        else
            echo "Docker login failed: $DOCKER_REGISTRY_TARGET"
            notify_host_hoot_error "docker login failed"
            exit 1
        fi
    fi
# Check if AWS ECR credentials exist
elif [[ -n "$DSTACK_AWS_ACCESS_KEY_ID" && -n "$DSTACK_AWS_SECRET_ACCESS_KEY" && -n "$DSTACK_AWS_REGION" && -n "$DSTACK_AWS_ECR_REGISTRY" ]]; then
    echo "AWS ECR credentials found"

    # Check if AWS CLI is installed
    if [ ! -f "./aws/dist/aws" ]; then
        notify_host_hoot_info "awscli not installed, installing..."
        echo "AWS CLI not installed, installing..."
        curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-2.24.14.zip" -o "awscliv2.zip"
        echo "6ff031a26df7daebbfa3ccddc9af1450 awscliv2.zip" | md5sum -c
        if [ $? -ne 0 ]; then
            echo "MD5 checksum failed"
            notify_host_hoot_error "awscli install failed"
            exit 1
        fi
        unzip awscliv2.zip &> /dev/null
    else
        echo "AWS CLI is already installed: ./aws/dist/aws"
    fi

    # Set AWS credentials as environment variables
    export AWS_ACCESS_KEY_ID="$DSTACK_AWS_ACCESS_KEY_ID"
    export AWS_SECRET_ACCESS_KEY="$DSTACK_AWS_SECRET_ACCESS_KEY"
    export AWS_DEFAULT_REGION="$DSTACK_AWS_REGION"

    # Set session token if provided (for temporary credentials)
    if [[ -n "$DSTACK_AWS_SESSION_TOKEN" ]]; then
        echo "AWS session token found, using temporary credentials"
        export AWS_SESSION_TOKEN="$DSTACK_AWS_SESSION_TOKEN"
    fi

    # Test AWS credentials before attempting ECR login
    echo "Testing AWS credentials..."
    if ! ./aws/dist/aws sts get-caller-identity &> /dev/null; then
        echo "AWS credentials test failed"
        # For session token credentials, this might be expected if they're expired
        # Log warning but don't fail startup
        if [[ -n "$DSTACK_AWS_SESSION_TOKEN" ]]; then
            echo "Warning: AWS temporary credentials may have expired, continuing startup"
            notify_host_hoot_info "AWS temporary credentials may have expired"
        else
            echo "AWS credentials test failed"
            notify_host_hoot_error "Invalid AWS credentials"
            exit 1
        fi
    else
        echo "Logging in to AWS ECR..."
        ./aws/dist/aws ecr get-login-password --region $DSTACK_AWS_REGION | docker login --username AWS --password-stdin "$DSTACK_AWS_ECR_REGISTRY"
        if [ $? -eq 0 ]; then
            echo "AWS ECR login successful"
            notify_host_hoot_info "AWS ECR login successful"
        else
            echo "AWS ECR login failed"
            # For session token credentials, don't fail startup if login fails
            if [[ -n "$DSTACK_AWS_SESSION_TOKEN" ]]; then
                echo "Warning: AWS ECR login failed with temporary credentials, continuing startup"
                notify_host_hoot_info "AWS ECR login failed with temporary credentials"
            else
                notify_host_hoot_error "AWS ECR login failed"
                exit 1
            fi
        fi
    fi
fi

perform_cleanup

#
# GHCR image pull access verification (pure HTTP, no docker daemon)
#
if [[ "$DOCKER_REGISTRY_TARGET" == "ghcr.io" && -n "$DSTACK_DOCKER_USERNAME" && -n "$DSTACK_DOCKER_PASSWORD" ]]; then
    COMPOSE_IMAGES=$(grep 'image:' /dstack/docker-compose.yaml 2>/dev/null | awk '{print $2}' | tr -d '"'"'" || true)
    for img in $COMPOSE_IMAGES; do
        [[ "$img" != ghcr.io/* ]] && continue
        repo="\${img#ghcr.io/}"; repo="\${repo%%:*}"
        tag="\${img##*:}"; [[ "$tag" == "$img" || "$tag" == "$repo" ]] && tag="latest"
        echo "Verifying GHCR pull access: $img"
        token=$(curl -sf -u "$DSTACK_DOCKER_USERNAME:$DSTACK_DOCKER_PASSWORD" \
            "https://ghcr.io/token?service=ghcr.io&scope=repository:\${repo}:pull" | jq -r '.token // empty' || true)
        if [[ -z "$token" ]]; then
            echo "ERROR: GHCR token exchange failed for $img"
            notify_host_hoot_error "GHCR token exchange failed: $img"
            exit 1
        fi
        http_code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $token" \
            "https://ghcr.io/v2/\${repo}/manifests/\${tag}")
        if [[ "$http_code" != "200" ]]; then
            echo "ERROR: GHCR pull access denied for $img (HTTP $http_code)"
            notify_host_hoot_error "GHCR pull access denied: $img (HTTP $http_code)"
            exit 1
        fi
        echo "GHCR pull access OK: $img"
    done
fi

#
# Set root password.
#
echo "Setting root password.."

# Check if password files are writable
PASSWD_WRITABLE=true
if [ ! -w /etc/passwd ]; then
    echo "Warning: /etc/passwd is read-only"
    PASSWD_WRITABLE=false
fi
if [ ! -w /etc/shadow ]; then
    echo "Warning: /etc/shadow is read-only"
    PASSWD_WRITABLE=false
fi

if [ "$PASSWD_WRITABLE" = "false" ]; then
    echo "Skipping password setup due to read-only file system"
else
    # Check if chpasswd is available
    if command -v chpasswd >/dev/null 2>&1; then
        echo "Using chpasswd method"

        if [ -n "$DSTACK_ROOT_PASSWORD" ]; then
            echo "Setting root password from user.."
            echo "root:$DSTACK_ROOT_PASSWORD" | chpasswd
            unset DSTACK_ROOT_PASSWORD
            echo "Root password set/updated from DSTACK_ROOT_PASSWORD"
        elif [ -z "$(grep '^root:' /etc/shadow 2>/dev/null | cut -d: -f2)" ]; then
            echo "Setting random root password.."
            DSTACK_ROOT_PASSWORD=$(
                LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | dd bs=1 count=32 2>/dev/null
            )
            echo "root:$DSTACK_ROOT_PASSWORD" | chpasswd
            unset DSTACK_ROOT_PASSWORD
            echo "Root password set (random auto-init)"
        else
            echo "Root password already set; no changes."
        fi
    else
        echo "Using passwd method"

        if [ -n "$DSTACK_ROOT_PASSWORD" ]; then
            echo "Setting root password from user.."
            echo "$DSTACK_ROOT_PASSWORD" | passwd --stdin root 2>/dev/null \
                || printf '%s\\n%s\\n' "$DSTACK_ROOT_PASSWORD" "$DSTACK_ROOT_PASSWORD" | passwd root
            unset DSTACK_ROOT_PASSWORD
            echo "Root password set/updated from DSTACK_ROOT_PASSWORD"
        elif [ -z "$(grep '^root:' /etc/shadow 2>/dev/null | cut -d: -f2)" ]; then
            echo "Setting random root password.."
            DSTACK_ROOT_PASSWORD=$(
                LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | dd bs=1 count=32 2>/dev/null
            )
            echo "$DSTACK_ROOT_PASSWORD" | passwd --stdin root 2>/dev/null \
                || printf '%s\\n%s\\n' "$DSTACK_ROOT_PASSWORD" "$DSTACK_ROOT_PASSWORD" | passwd root
            unset DSTACK_ROOT_PASSWORD
            echo "Root password set (random auto-init)"
        else
            echo "Root password already set; no changes."
        fi
    fi
fi

#
# Set SSH authorized keys
#
if mkdir -p /home/root/.ssh 2>/dev/null; then
    if [[ -n "$DSTACK_ROOT_PUBLIC_KEY" ]]; then
        echo "$DSTACK_ROOT_PUBLIC_KEY" > /home/root/.ssh/authorized_keys
        unset $DSTACK_ROOT_PUBLIC_KEY
        echo "Root public key set"
    fi
    if [[ -n "$DSTACK_AUTHORIZED_KEYS" ]]; then
        echo "$DSTACK_AUTHORIZED_KEYS" > /home/root/.ssh/authorized_keys
        unset $DSTACK_AUTHORIZED_KEYS
        echo "Root authorized_keys set"
    fi

    if [[ -f /dstack/user_config ]] && jq empty /dstack/user_config 2>/dev/null; then
        if [[ $(jq 'has("ssh_authorized_keys")' /dstack/user_config 2>/dev/null) == "true" ]]; then
            jq -j '.ssh_authorized_keys' /dstack/user_config >> /home/root/.ssh/authorized_keys
            # Remove duplicates if there are multiple keys
            if [[ $(cat /home/root/.ssh/authorized_keys | wc -l) -gt 1 ]]; then
                sort -u /home/root/.ssh/authorized_keys > /home/root/.ssh/authorized_keys.tmp
                mv /home/root/.ssh/authorized_keys.tmp /home/root/.ssh/authorized_keys
            fi
            echo "Set root authorized_keys from user preferences, total" $(cat /home/root/.ssh/authorized_keys | wc -l) "keys"
        fi
    fi
else
    echo "Warning: Cannot create /home/root/.ssh directory (read-only file system?)"
    echo "Skipping SSH key setup"
fi

if [[ -S /var/run/dstack.sock ]]; then
    export DSTACK_APP_ID=$(curl -s --unix-socket /var/run/dstack.sock http://dstack/Info | jq -j .app_id)
elif [[ -S /var/run/tappd.sock ]]; then
    export DSTACK_APP_ID=$(curl -s --unix-socket /var/run/tappd.sock http://dstack/prpc/Tappd.Info | jq -j .app_id)
fi
# Check if DSTACK_GATEWAY_DOMAIN is not set, try to get it from user_config or app-compose.json
# Priority: user_config > app-compose.json
if [[ -z "$DSTACK_GATEWAY_DOMAIN" ]]; then
    # First try to get from /dstack/user_config if it exists and is valid JSON
    if [[ -f /dstack/user_config ]] && jq empty /dstack/user_config 2>/dev/null; then
        if [[ $(jq 'has("default_gateway_domain")' /dstack/user_config 2>/dev/null) == "true" ]]; then
            export DSTACK_GATEWAY_DOMAIN=$(jq -j '.default_gateway_domain' /dstack/user_config)
        fi
    fi

    # If still not set, try to get from app-compose.json
    if [[ -z "$DSTACK_GATEWAY_DOMAIN" ]] && [[ $(jq 'has("default_gateway_domain")' app-compose.json) == "true" ]]; then
        export DSTACK_GATEWAY_DOMAIN=$(jq -j '.default_gateway_domain' app-compose.json)
    fi
fi
if [[ -n "$DSTACK_GATEWAY_DOMAIN" ]]; then
    export DSTACK_APP_DOMAIN=$DSTACK_APP_ID"."$DSTACK_GATEWAY_DOMAIN
fi

echo "----------------------------------------------"
echo "Script execution completed"
echo "----------------------------------------------"
`;
