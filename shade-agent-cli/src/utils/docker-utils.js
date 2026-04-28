import { execFileSync } from "child_process";
import { platform } from "os";

// Get the sudo prefix for Docker commands based on the OS
export function getSudoPrefix() {
  const platformName = platform();
  return platformName === "linux" ? "sudo " : "";
}

// Run `docker <args>` (or `sudo docker <args>` on Linux) without a shell.
// Arguments are passed via execFileSync's argv array — no parsing, no
// interpolation, no shell-injection class of bug. Use this instead of
// execSync(`docker ...${userInput}...`) whenever any argument originates
// from deployment.yaml or any other untrusted source.
export function dockerExec(args, opts = {}) {
  return runWithSudoOnLinux("docker", args, opts);
}

// Generic version of dockerExec: run `<file> <args>` (or
// `sudo <file> <args>` on Linux) with no shell.
export function runWithSudoOnLinux(file, args, opts = {}) {
  const linux = platform() === "linux";
  return execFileSync(
    linux ? "sudo" : file,
    linux ? [file, ...args] : args,
    opts,
  );
}
