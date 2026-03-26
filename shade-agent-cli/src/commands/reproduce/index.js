import { Command } from "commander";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";
import chalk from "chalk";
import { createCommandErrorHandler } from "../../utils/error-handler.js";
import {
  runReproducibleDockerBuild,
  getDockerImageId,
  REPRODUCE_LOCAL_IMAGE,
} from "../deploy/docker.js";
import { calculateAppComposeHash } from "../../utils/measurements.js";


function readReproducePaths() {
  const deploymentPath = path.resolve(process.cwd(), "deployment.yaml");
  if (!existsSync(deploymentPath)) {
    console.log(
      chalk.red(
        `deployment.yaml not found at ${deploymentPath}. Run this command from your project root.`,
      ),
    );
    process.exit(1);
  }
  const doc = parseYaml(readFileSync(deploymentPath, "utf8")) || {};
  const dockerfilePath = doc.build_docker_image?.dockerfile_path;
  if (!dockerfilePath || typeof dockerfilePath !== "string") {
    console.log(
      chalk.red(
        "deployment.yaml must set build_docker_image.dockerfile_path (string) for `shade reproduce`.",
      ),
    );
    process.exit(1);
  }
  const dockerComposePath = doc.docker_compose_path;
  if (!dockerComposePath || typeof dockerComposePath !== "string") {
    console.log(
      chalk.red(
        "deployment.yaml must set docker_compose_path (string) for `shade reproduce` (needed for the app compose hash).",
      ),
    );
    process.exit(1);
  }
  return {
    dockerfilePath: path.resolve(process.cwd(), dockerfilePath),
    composePath: path.resolve(process.cwd(), dockerComposePath),
  };
}

export function reproduceCommand() {
  const cmd = new Command("reproduce");
  cmd.description(
    "Produces the hash of the reproducible Docker image and the app compose hash",
  );
  cmd.configureOutput(createCommandErrorHandler("reproduce", { maxArgs: 0 }));

  cmd.action(() => {
    const { dockerfilePath, composePath } = readReproducePaths();
    if (!existsSync(composePath)) {
      console.log(
        chalk.red(`docker compose file not found at ${composePath}`),
      );
      process.exit(1);
    }

    console.log("Building Docker image (reproducible)");
    runReproducibleDockerBuild(dockerfilePath, REPRODUCE_LOCAL_IMAGE, "");
    const imageHash = getDockerImageId(REPRODUCE_LOCAL_IMAGE);
    console.log(chalk.white(`Reproducible image hash: ${imageHash}`));

    let appComposeHash;
    try {
      appComposeHash = calculateAppComposeHash(composePath);
    } catch (e) {
      console.log(
        chalk.red(`Error computing app compose hash: ${e.message}`),
      );
      process.exit(1);
    }
    console.log(chalk.white(`App compose hash: ${appComposeHash}`));
  });

  return cmd;
}