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

/**
 * Reads only build_docker_image.dockerfile_path from deployment.yaml (raw parse).
 * Ignores enabled, tag, cache, and other keys so `shade reproduce` stays independent.
 */
function readDockerfilePathOnly() {
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
  return path.resolve(process.cwd(), dockerfilePath);
}

export function reproduceCommand() {
  const cmd = new Command("reproduce");
  cmd.description(
    "Build the Docker image with the reproducible Buildx flow and print the local image ID (uses only build_docker_image.dockerfile_path from deployment.yaml)",
  );
  cmd.configureOutput(createCommandErrorHandler("reproduce", { maxArgs: 0 }));

  cmd.action(() => {
    const absDockerfile = readDockerfilePathOnly();
    console.log("Building Docker image (reproducible)");
    runReproducibleDockerBuild(absDockerfile, REPRODUCE_LOCAL_IMAGE, "");
    const id = getDockerImageId(REPRODUCE_LOCAL_IMAGE);
    console.log(chalk.green(`Image ID: ${id}`));
  });

  return cmd;
}
