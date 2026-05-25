import {
  getCollateral as dcapGetCollateral,
  PHALA_PCCS_URL,
  INTEL_PCS_URL,
} from "@phala/dcap-qvl";
import { checkCollateralFreshness } from "./collateral-freshness";
import { genericError, withRetry } from "./errors";
import type { Collateral } from "./tee";

// Mirrors mpc's shipped cvm-deployment/user-config.toml: Phala PCCS first,
// Intel PCS as a fallback. Replaced wholesale when the user passes
// `pccsEndpoints` to ShadeClient.create.
export const DEFAULT_PCCS_ENDPOINTS: readonly string[] = [
  PHALA_PCCS_URL,
  INTEL_PCS_URL,
];

// Per-endpoint timeout. Matches mpc's PCCS_REQUEST_TIMEOUT in
// tee_authority.rs:225.
const PER_ENDPOINT_TIMEOUT_MS = 10_000;

// Per-endpoint retry budget (1 retry → 2 total attempts). Matches mpc's
// `get_with_backoff(..., Some(1))` invocation in tee_authority.rs:505.
const PER_ENDPOINT_RETRY_DELAY_MS = 500;

// Cast dcap-qvl's `Collateral` (which types binary fields as `number[] | string`)
// down to the contract-facing `Collateral` (always `number[]`). The runtime
// implementation always returns `number[]` via `Array.from(Buffer)` —
// see @phala/dcap-qvl/src/collateral.js:309-316.
function projectToContractShape(raw: {
  pck_crl_issuer_chain: string;
  root_ca_crl: number[] | string;
  pck_crl: number[] | string;
  tcb_info_issuer_chain: string;
  tcb_info: string;
  tcb_info_signature: number[] | string;
  qe_identity_issuer_chain: string;
  qe_identity: string;
  qe_identity_signature: number[] | string;
}): Collateral {
  const asBytes = (v: number[] | string): number[] =>
    Array.isArray(v) ? v : Array.from(Buffer.from(v, "hex"));
  return {
    pck_crl_issuer_chain: raw.pck_crl_issuer_chain,
    root_ca_crl: asBytes(raw.root_ca_crl),
    pck_crl: asBytes(raw.pck_crl),
    tcb_info_issuer_chain: raw.tcb_info_issuer_chain,
    tcb_info: raw.tcb_info,
    tcb_info_signature: asBytes(raw.tcb_info_signature),
    qe_identity_issuer_chain: raw.qe_identity_issuer_chain,
    qe_identity: raw.qe_identity,
    qe_identity_signature: asBytes(raw.qe_identity_signature),
  };
}

// Fetch from a single PCCS endpoint with a per-request timeout and 1 retry.
// Mirrors mpc's `fetch_collateral_from` (tee_authority.rs:482-516).
//
// The timeout is a soft one: @phala/dcap-qvl does not accept an AbortSignal,
// so the underlying fetch may complete after we've stopped waiting. From
// this caller's perspective the result is the same — we stop blocking and
// move on to the next endpoint.
async function fetchFromOneEndpoint(
  url: string,
  quoteBytes: Buffer,
): Promise<Collateral> {
  return withRetry(
    async () => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new Error(
              `PCCS request timed out after ${PER_ENDPOINT_TIMEOUT_MS}ms`,
            ),
          );
        }, PER_ENDPOINT_TIMEOUT_MS);
      });
      try {
        const raw = (await Promise.race([
          dcapGetCollateral(url, quoteBytes),
          timeout,
        ])) as Parameters<typeof projectToContractShape>[0];
        return projectToContractShape(raw);
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    },
    { attempts: 2, delayMs: [PER_ENDPOINT_RETRY_DELAY_MS] },
  );
}

// Try each PCCS endpoint in order, returning the first endpoint's
// collateral that passes the freshness check. On per-endpoint failure
// (HTTP/timeout/parse) OR freshness rejection, fall through to the next
// endpoint. If every endpoint fails, throw a single error aggregating
// every per-endpoint failure.
//
// Mirrors mpc's `try_each_pccs_endpoint` (tee_authority.rs:629-680) and
// the freshness-ladder behaviour described at tee_authority.rs:533-536.
export async function fetchCollateralWithFallback(
  pccsEndpoints: readonly string[],
  quoteBytes: Buffer,
  now: Date,
): Promise<Collateral> {
  if (pccsEndpoints.length === 0) {
    throw genericError("pccsEndpoints must be a non-empty array");
  }

  const failures: { url: string; error: unknown }[] = [];
  const total = pccsEndpoints.length;

  for (let i = 0; i < total; i++) {
    const url = pccsEndpoints[i]!;
    try {
      const collateral = await fetchFromOneEndpoint(url, quoteBytes);
      checkCollateralFreshness(collateral, now);
      if (i > 0) {
        console.info(
          `Fetched collateral via PCCS fallback (attempt ${i + 1}/${total}, url ${url})`,
        );
      }
      return collateral;
    } catch (error) {
      failures.push({ url, error });
    }
  }

  const summary = failures
    .map(
      ({ url, error }, idx) =>
        `  [${idx + 1}/${total}] ${url}: ${(error as Error)?.message ?? String(error)}`,
    )
    .join("\n");
  throw Object.assign(
    new Error(`All ${total} PCCS endpoints failed:\n${summary}`),
    { failures },
  );
}
