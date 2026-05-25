import {
  getCollateral as dcapGetCollateral,
  PHALA_PCCS_URL,
  INTEL_PCS_URL,
  type Collateral as DcapCollateral,
} from "@phala/dcap-qvl";
import { checkCollateralFreshness } from "./collateral-freshness";
import { genericError, withRetry } from "./errors";

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
): Promise<DcapCollateral> {
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
        return (await Promise.race([
          dcapGetCollateral(url, quoteBytes),
          timeout,
        ])) as DcapCollateral;
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
): Promise<DcapCollateral> {
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
