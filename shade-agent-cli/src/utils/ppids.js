import chalk from "chalk";
import { getPpidFromKmsQuote } from "./dstack-kms.js";

const PHALA_PPIDS_API_URL =
  "https://cloud-api.phala.network/api/v1/attestations/ppids";

const LOCAL_PPID = "00000000000000000000000000000000";

/**
 * The PPIDs to approve for registration. Local mode gets a mock; a self-hosted
 * dstack server has exactly one, read off its own KMS; Phala Cloud publishes
 * the list of every device it runs on.
 *
 * @param {object} deployment - Parsed deployment.yaml
 */
export async function getPpids(deployment) {
  if (deployment?.environment !== "TEE") {
    return [LOCAL_PPID];
  }

  if (deployment?.tee_target?.backend === "dstack") {
    return [getPpidFromKmsQuote(deployment.deploy_to_dstack.ssh_host)];
  }

  const response = await fetch(PHALA_PPIDS_API_URL);
  if (!response.ok) {
    console.log(
      chalk.red(
        `Error: failed to fetch PPIDs from Phala API: ${response.status} ${response.statusText}`,
      ),
    );
    process.exit(1);
  }

  const ppids = await response.json();
  if (!Array.isArray(ppids)) {
    console.log(
      chalk.red("Error: Phala PPIDs API did not return an array"),
    );
    process.exit(1);
  }

  return ppids;
}
