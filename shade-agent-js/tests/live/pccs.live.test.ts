// Opt-in network test (`npm run test:live`, not part of `npm test` or CI):
// runs the real PCCS fallback ladder against pccs.phala.network and Intel's
// PCS with the sample TDX quote from the dcap-qvl crate, then checks the
// fetched bundle with dcap-qvl's own verifier. Its TCB status is OutOfDate
// (the sample platform is old); what matters is that verification runs to
// completion, which proves the collateral is complete and Intel-signed.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { verify, INTEL_PCS_URL, PHALA_PCCS_URL } from "@phala/dcap-qvl";
import {
  fetchCollateralWithFallback,
  DEFAULT_PCCS_ENDPOINTS,
} from "../../src/utils/collateral";
import { attestationForContract } from "../../src/utils/attestation-transform";

const quote = Buffer.from(
  readFileSync(join(__dirname, "../fixtures/tdx-quote.hex"), "utf8").trim(),
  "hex",
);
const nowSecs = () => Math.floor(Date.now() / 1000);
const HEX = /^[0-9a-f]+$/;

describe("live PCCS ladder", () => {
  it("fetches through the default ladder and the bundle verifies", async () => {
    const collateral = await fetchCollateralWithFallback(
      DEFAULT_PCCS_ENDPOINTS,
      quote,
      new Date(),
    );
    const report = verify(quote, collateral, nowSecs());
    expect(report.status).toBeTruthy();

    const forContract = attestationForContract({
      quote: Array.from(quote),
      collateral,
      tcb_info: {} as never,
    });
    expect(forContract.collateral.pck_crl).toMatch(HEX);
    expect(forContract.collateral.root_ca_crl).toMatch(HEX);
    expect(forContract.collateral.tcb_info_signature).toMatch(HEX);
    expect(forContract.collateral.qe_identity_signature).toMatch(HEX);
    expect(JSON.parse(forContract.collateral.tcb_info).fmspc).toBe(
      "B0C06F000000",
    );
  }, 60_000);

  it.each([
    ["Intel PCS", INTEL_PCS_URL],
    ["Phala PCCS", PHALA_PCCS_URL],
  ])("fetches from %s alone and the bundle verifies", async (_name, url) => {
    const collateral = await fetchCollateralWithFallback(
      [url],
      quote,
      new Date(),
    );
    expect(verify(quote, collateral, nowSecs()).status).toBeTruthy();
  }, 60_000);

  it("falls through a dead endpoint to the next one", async () => {
    const collateral = await fetchCollateralWithFallback(
      ["https://127.0.0.1:9", INTEL_PCS_URL],
      quote,
      new Date(),
    );
    expect(collateral.tcb_info).toContain('"fmspc":"B0C06F000000"');
  }, 60_000);
});
