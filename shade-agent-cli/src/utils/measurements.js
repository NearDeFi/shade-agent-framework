import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { parse } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read the pre launch script from a file
const PRE_LAUNCH_SCRIPT = fs.readFileSync(
  path.join(__dirname, "phala-cloud-prelaunch.sh"),
  "utf8",
);

export function getMeasurements(isTee, dockerComposePath, dstackVersion, instanceType) {
  if (!isTee) {
    return localMeasurements;
  }

  if (!dockerComposePath) {
    console.log(
      chalk.red("Error: dockerComposePath is required when isTee is true"),
    );
    process.exit(1);
  }

  if (!dstackVersion || !instanceType) {
    console.log(
      chalk.red(
        "Error: dstack_version and instance_type (from deploy_to_phala) are required to calculate TEE measurements",
      ),
    );
    process.exit(1);
  }

  return createTeeMeasurements(calculateAppComposeHash(dockerComposePath), dstackVersion, instanceType);
}

function createTeeMeasurements(appComposeHash, dstackVersion, instanceType) {
  const versionMeasurements = hardwareAndOSMeasurements[dstackVersion];
  if (!versionMeasurements) {
    const supported = Object.keys(hardwareAndOSMeasurements).join(", ");
    console.log(
      chalk.red(
        `Error: unsupported dstack_version "${dstackVersion}". Supported versions: ${supported}`,
      ),
    );
    process.exit(1);
  }

  const hwMeasurements = versionMeasurements[instanceType];
  if (!hwMeasurements) {
    const supported = Object.keys(versionMeasurements).join(", ");
    console.log(
      chalk.red(
        `Error: unsupported instance_type "${instanceType}" for dstack_version "${dstackVersion}". Supported types: ${supported}`,
      ),
    );
    process.exit(1);
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

