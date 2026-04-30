import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { parse, stringify } from "yaml";
import chalk from "chalk";
import { getConfig } from "../../utils/config.js";
import { getSudoPrefix, dockerExec } from "../../utils/docker-utils.js";

/** Pinned BuildKit for reproducible image metadata. */
const REPRO_BUILDKIT_VERSION = "0.27.1";
const REPRO_PLATFORM = "linux/amd64";
const REPRO_SOURCE_DATE_EPOCH = "0";

function shellQuote(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function assertDockerBuildx(sudoPrefix) {
  try {
    execSync(`${sudoPrefix}docker buildx version`, { stdio: "pipe" });
  } catch {
    console.log(
      chalk.red(
        "Error: Docker Buildx is required (Docker Desktop or docker-buildx-plugin on Linux).",
      ),
    );
    process.exit(1);
  }
}

/**
 * Run the reproducible Buildx flow (pinned BuildKit, SOURCE_DATE_EPOCH, rewrite-timestamp).
 * @param {string} absDockerfilePath - Absolute path to Dockerfile
 * @param {string} fullImageRef - e.g. "repo/name:tag" for --output name=
 * @param {string} cacheFlag - "" or "--no-cache"
 */
export function runReproducibleDockerBuild(
  absDockerfilePath,
  fullImageRef,
  cacheFlag,
) {
  const sudoPrefix = getSudoPrefix();
  assertDockerBuildx(sudoPrefix);
  const builder = ensureReproducibleBuilder(sudoPrefix);
  const buildContext = path.dirname(absDockerfilePath);
  const outputArg = `type=docker,name=${fullImageRef},rewrite-timestamp=true`;
  const cmd = [
    `${sudoPrefix}docker buildx build`,
    `--builder ${builder}`,
    `--platform ${REPRO_PLATFORM}`,
    cacheFlag,
    `--build-arg SOURCE_DATE_EPOCH=${REPRO_SOURCE_DATE_EPOCH}`,
    `--output ${shellQuote(outputArg)}`,
    `--progress quiet`,
    `-f ${shellQuote(absDockerfilePath)}`,
    shellQuote(buildContext),
  ]
    .filter(Boolean)
    .join(" ");
  try {
    execSync(cmd, { stdio: "pipe" });
  } catch (e) {
    const stderr =
      e && typeof e.stderr !== "undefined" && e.stderr
        ? e.stderr.toString().trim()
        : "";
    console.log(chalk.red(`Error building the Docker image: ${e.message}`));
    if (stderr) {
      console.log(chalk.gray(stderr));
    }
    process.exit(1);
  }
}

/** Local tag used only by `shade reproduce` (not read from deployment.yaml). */
export const REPRODUCE_LOCAL_IMAGE = "shade-repro:local";

export function getDockerImageId(imageRef) {
  const sudoPrefix = getSudoPrefix();
  return execSync(
    `${sudoPrefix}docker image inspect ${shellQuote(imageRef)} --format '{{.Id}}'`,
    { encoding: "utf8", stdio: "pipe" },
  ).trim();
}

function ensureReproducibleBuilder(sudoPrefix) {
  const name = `shade-repro-buildkit-${REPRO_BUILDKIT_VERSION}`;
  try {
    execSync(`${sudoPrefix}docker buildx inspect ${name}`, { stdio: "pipe" });
  } catch {
    execSync(
      `${sudoPrefix}docker buildx create --name ${name} --driver-opt image=moby/buildkit:v${REPRO_BUILDKIT_VERSION}`,
      { stdio: "pipe" },
    );
  }
  return name;
}

// Update the docker-compose image in the docker-compose file
export async function replaceInYaml(dockerTag, codehash) {
  console.log("Replacing the codehash in the yaml file");
  try {
    const config = await getConfig();
    const path = config.deployment.docker_compose_path;
    const compose = readFileSync(path, "utf8");
    const doc = parse(compose);

    if (!doc.services || !doc.services["shade-agent-app"]) {
      console.log(
        chalk.red(`Could not find services.shade-agent-app in ${path}`),
      );
      process.exit(1);
    }

    // Set image to tag@sha256:codehash
    doc.services["shade-agent-app"].image = `${dockerTag}@sha256:${codehash}`;

    const updated = stringify(doc);
    writeFileSync(path, updated, "utf8");
  } catch (e) {
    console.log(
      chalk.red(`Error replacing codehash in the yaml file: ${e.message}`),
    );
    process.exit(1);
  }
}

// Build the Docker image
export async function buildImage(dockerTag) {
  const config = await getConfig();
  const reproducible =
    config.deployment.build_docker_image.reproducible_build === true;
  console.log(
    `Building the Docker image (${reproducible ? "reproducible" : "non-reproducible"})`,
  );
  try {
    const cacheFlag =
      config.deployment.build_docker_image.cache === false ? "--no-cache" : "";
    const dockerfilePath = config.deployment.build_docker_image.dockerfile_path;
    const resolvedDockerfile = path.resolve(dockerfilePath);
    const buildContext = path.dirname(resolvedDockerfile);
    const fullTag = `${dockerTag}:latest`;

    if (reproducible) {
      runReproducibleDockerBuild(resolvedDockerfile, fullTag, cacheFlag);
    } else {
      const args = ["build"];
      if (cacheFlag) args.push(cacheFlag);
      args.push(
        "-f",
        resolvedDockerfile,
        "--platform=linux/amd64",
        "-t",
        fullTag,
        buildContext,
      );
      dockerExec(args, { stdio: "pipe" });
    }
  } catch (e) {
    const stderr =
      e && typeof e.stderr !== "undefined" && e.stderr
        ? e.stderr.toString().trim()
        : "";
    console.log(chalk.red(`Error building the Docker image: ${e.message}`));
    if (stderr) {
      console.log(chalk.gray(stderr));
    }
    process.exit(1);
  }
}

// Push the Docker image to docker hub
export async function pushImage(dockerTag) {
  // Pushes the image to docker hub
  console.log("Pushing the Docker image");
  try {
    const output = dockerExec(["push", dockerTag], {
      encoding: "utf-8",
      stdio: "pipe",
    });
    const match = output.toString().match(/sha256:[a-f0-9]{64}/gim);
    if (!match || !match[0]) {
      console.log(
        chalk.red(
          "Error: Could not extract codehash from the Docker push output",
        ),
      );
      process.exit(1);
    }
    const newAppCodehash = match[0].split("sha256:")[1];
    return newAppCodehash;
  } catch (e) {
    console.log(chalk.red(`Error pushing the Docker image: ${e.message}`));
    process.exit(1);
  }
}

// Build the Docker image and push it to docker hub
export async function dockerImage() {
  const config = await getConfig();
  const dockerTag = config.deployment.build_docker_image.tag;
  // Builds the image
  await buildImage(dockerTag);

  // Pushes the image and gets the new codehash
  const newAppCodehash = await pushImage(dockerTag);

  // Replaces the codehash in the yaml file
  await replaceInYaml(dockerTag, newAppCodehash);

  return newAppCodehash;
}
