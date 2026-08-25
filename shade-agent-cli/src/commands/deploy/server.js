import chalk from "chalk";
import { getConfig } from "../../utils/config.js";
import { deployToDstack } from "../../utils/dstack-deploy.js";
import { VMM_URL } from "../../utils/dstack-transport.js";

// Deploy the app to the self-hosted dstack server and report where it lives
export async function deployServerWorkflow() {
  const config = await getConfig();
  const result = await deployToDstack(config.deployment);

  if (result.appUrls.length > 0) {
    console.log(`\nYour app is live at:`);
    result.appUrls.forEach((url, index) => {
      console.log(`  ${index + 1}. ${url}`);
    });
  } else {
    console.log(
      `\nThe compose publishes no ports, so the app is not reachable through the gateway.`,
    );
  }
  console.log(
    `\nCVM management: ${VMM_URL}/ (tunnel it with ` +
      `\`ssh -L 10000:127.0.0.1:10000 ${config.deployment.tee_config.server.ssh_host}\`)`,
  );
  console.log(
    chalk.gray(
      `The app id is generated per deploy, so this URL changes every time and the CVM starts with a fresh encrypted disk.`,
    ),
  );

  return result.vmId;
}
