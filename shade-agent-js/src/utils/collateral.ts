import {
  getCollateral as dcapGetCollateral,
  Quote,
  PHALA_PCCS_URL,
  INTEL_PCS_URL,
  type Collateral as DcapCollateral,
} from "@phala/dcap-qvl";
import { checkCollateralFreshness } from "./collateral-freshness";
import { defaultRetryable, genericError, withRetry } from "./errors";

// Default ladder: Phala PCCS first, Intel PCS as the fallback. Replaced
// wholesale when the user passes `pccsEndpoints` to ShadeClient.create.
export const DEFAULT_PCCS_ENDPOINTS: readonly string[] = [
  PHALA_PCCS_URL,
  INTEL_PCS_URL,
];

// Wraps the whole per-endpoint bundle (PCK CRL, TCB info, QE identity and
// root CRL, fetched sequentially inside dcap-qvl).
const PER_ENDPOINT_TIMEOUT_MS = 10_000;

// One retry per endpoint (2 attempts).
const PER_ENDPOINT_RETRY_DELAY_MS = 500;

// dcap-qvl reports a non-2xx response as a plain Error whose message ends
// in ": <status>" and carries no `.status` field, so the default predicate
// would retry deterministic 4xx failures (unknown FMSPC, missing PCK cert).
function pccsRetryable(error: unknown): boolean {
  const match = /: (\d{3})$/.exec((error as Error)?.message ?? "");
  if (match) {
    const status = Number(match[1]);
    if (status >= 400 && status < 500) {
      return status === 408 || status === 429;
    }
  }
  return defaultRetryable(error);
}

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
            genericError(
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
    {
      attempts: 2,
      delayMs: [PER_ENDPOINT_RETRY_DELAY_MS],
      retryable: pccsRetryable,
    },
  );
}

// Try each PCCS endpoint in order, returning the first endpoint's
// collateral that passes the freshness check. On per-endpoint failure
// (HTTP/timeout/parse) OR freshness rejection, fall through to the next
// endpoint. If every endpoint fails, throw an AggregateError whose
// `errors` are the per-endpoint failures in order (toThrowable preserves
// them, so a FreshnessError's fields stay reachable to the caller).
export async function fetchCollateralWithFallback(
  pccsEndpoints: readonly string[],
  quoteBytes: Buffer,
  now: Date,
): Promise<DcapCollateral> {
  if (pccsEndpoints.length === 0) {
    throw genericError("pccsEndpoints must be a non-empty array");
  }

  // A malformed quote fails here once instead of being retried against
  // every endpoint (dcap-qvl parses it again before its first request).
  Quote.parse(quoteBytes);

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
  throw new AggregateError(
    failures.map(({ error }) => error),
    `All ${total} PCCS endpoints failed:\n${summary}`,
  );
}
