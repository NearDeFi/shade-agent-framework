import chalk from "chalk";
import { getConfig } from "../../utils/config.js";
import { extractAllowedEnvs } from "../../utils/measurements.js";
import { deployToPhala as deployToPhalaSdk } from "../../utils/phala-deploy.js";

// Use native fetch (available in Node.js 18+)
const fetchFn = globalThis.fetch;

// Get the app name from the deployment.yaml file
async function getAppNameFromDeployment() {
  const config = await getConfig();
  const appName = config.deployment?.deploy_to_phala?.app_name;
  if (!appName || typeof appName !== "string") {
    console.log(
      chalk.red("deploy_to_phala.app_name is required in deployment.yaml"),
    );
    process.exit(1);
  }
  return appName;
}

// Deploy the app to Phala Cloud
export async function deployToPhala() {
  // Deploys the app to Phala Cloud using @phala/cloud SDK
  console.log("Deploying to Phala Cloud");
  const appName = await getAppNameFromDeployment();

  // Validate app name length
  if (appName.length <= 3) {
    console.log(
      chalk.red("Error: Docker tag app name must be longer than 3 characters"),
    );
    process.exit(1);
  }

  try {
    const config = await getConfig();
    const phalaKey = config.phalaKey;
    if (!phalaKey) {
      console.log(chalk.red("Phala API key is required. Run `shade auth set` to configure it."));
      process.exit(1);
    }

    const composePath = config.deployment.docker_compose_path;
    const envFilePath = config.deployment?.deploy_to_phala?.env_file_path;
    const allowedEnvs = extractAllowedEnvs(composePath);

    const deployResult = await deployToPhalaSdk({
      appName,
      apiKey: phalaKey,
      composePath,
      envFilePath,
      allowedEnvKeys: allowedEnvs,
    });

    if (!deployResult.success) {
      console.log(chalk.red("Deployment failed"));
      process.exit(1);
    }

    if (deployResult.dashboard_url) {
      console.log(
        `\nPhala Application Dashboard URL: ${deployResult.dashboard_url}`,
      );
    }

    if (deployResult.vm_uuid) {
      return deployResult.vm_uuid;
    }
    console.log(
      chalk.red("Could not extract vm_uuid from deployment response"),
    );
    process.exit(1);
  } catch (e) {
    console.log(chalk.red(`Error deploying to Phala Cloud: ${e.message}`));
    process.exit(1);
  }
}

// Get the app URL from the app ID
export async function getAppUrl(appId) {
  const config = await getConfig();
  const phalaKey = config.phalaKey;
  console.log("Getting the app URL");
  const url = `https://cloud-api.phala.network/api/v1/cvms/${appId}`;
  const maxAttempts = 5;
  const delay = 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchFn(url, {
        headers: { "X-API-Key": phalaKey },
      });
      if (!response.ok) {
        if (attempt === maxAttempts) {
          console.log(chalk.red(`HTTP error! status: ${response.status}`));
        }
        continue;
      }
      const data = await response.json();
      if (!data.error) {
        // List all non-empty public URLs
        if (Array.isArray(data.public_urls)) {
          const validUrls = data.public_urls.filter(
            (u) => u.app && u.app.trim() !== "",
          );
          if (validUrls.length > 0) {
            // Print URLs and exit immediately
            console.log(`\nYour app is live at:`);
            validUrls.forEach((urlObj, index) => {
              console.log(
                `  ${index + 1}. ${urlObj.app}${urlObj.instance ? ` (instance: ${urlObj.instance})` : ""}`,
              );
            });
            return validUrls;
          }
        }
      }
    } catch (e) {
      if (attempt === maxAttempts) {
        console.log(
          chalk.red(
            `Error fetching CVM network info (attempt ${attempt}): ${e.message}`,
          ),
        );
      }
    }
    if (attempt < maxAttempts) {
      await new Promise((res) => setTimeout(res, delay));
    }
  }
  console.log(
    chalk.red(
      `Failed to get app URL: CVM Network Info did not become ready after ${maxAttempts} attempts.`,
    ),
  );
  return null;
}

// Deploy to phala and get the app URL
export async function deployPhalaWorkflow() {
  // Deploys the app to Phala Cloud
  const appId = await deployToPhala();

  // Gets the app URL from the app ID
  await getAppUrl(appId);
}
