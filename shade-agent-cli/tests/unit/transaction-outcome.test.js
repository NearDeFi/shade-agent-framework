/**
 * Unit tests for src/utils/transaction-outcome.js
 *
 * Coverage:
 *  - checkTransactionOutcome:
 *      true  on a SuccessValue with a non-"false" payload.
 *      false when SuccessValue base64-decodes to "false" (NEAR's bool sentinel).
 *      false on Failure / NotStarted / Started status.
 *      false when transaction_outcome is missing.
 *  - checkTransactionResponse:
 *      delegates via final_execution_outcome.
 *      handles a flat outcome (status + transaction_outcome inline).
 *      false on a malformed response.
 */
import { describe, it, expect } from "vitest";
import {
  checkTransactionOutcome,
  checkTransactionResponse,
} from "../../src/utils/transaction-outcome.js";

describe("checkTransactionOutcome", () => {
  // Healthy success path: SuccessValue is a non-"false" payload → true.
  it("returns true on a regular SuccessValue", () => {
    const outcome = {
      transaction_outcome: { id: "tx" },
      status: { SuccessValue: Buffer.from("ok").toString("base64") },
    };
    expect(checkTransactionOutcome(outcome)).toBe(true);
  });

  // NEAR contracts encode `false` returns as base64("false"). The decoder
  // must catch that case and report failure even though the TX itself
  // succeeded.
  it("returns false when SuccessValue base64-decodes to 'false'", () => {
    const outcome = {
      transaction_outcome: { id: "tx" },
      status: { SuccessValue: Buffer.from("false").toString("base64") },
    };
    expect(checkTransactionOutcome(outcome)).toBe(false);
  });

  // Explicit Failure status is unambiguous failure.
  it("returns false on a Failure status", () => {
    expect(
      checkTransactionOutcome({
        transaction_outcome: { id: "tx" },
        status: { Failure: { error: "boom" } },
      }),
    ).toBe(false);
  });

  // No transaction_outcome means the result is malformed; treat as failure.
  it("returns false when transaction_outcome is missing", () => {
    expect(
      checkTransactionOutcome({ status: { SuccessValue: "" } }),
    ).toBe(false);
  });

  // NotStarted / Started should never reach the caller, but are treated as
  // failure if they do.
  it("returns false on NotStarted / Started", () => {
    expect(
      checkTransactionOutcome({
        transaction_outcome: { id: "tx" },
        status: { NotStarted: true },
      }),
    ).toBe(false);
    expect(
      checkTransactionOutcome({
        transaction_outcome: { id: "tx" },
        status: { Started: true },
      }),
    ).toBe(false);
  });
});

describe("checkTransactionResponse", () => {
  // The standard NEAR client wraps the outcome in final_execution_outcome.
  it("delegates to checkTransactionOutcome via final_execution_outcome", () => {
    expect(
      checkTransactionResponse({
        final_execution_outcome: {
          transaction_outcome: { id: "tx" },
          status: { SuccessValue: "" },
        },
      }),
    ).toBe(true);
  });

  // Some flows pass an outcome directly; the helper handles that shape too.
  it("accepts a flat outcome (status + transaction_outcome inline)", () => {
    expect(
      checkTransactionResponse({
        transaction_outcome: { id: "tx" },
        status: { SuccessValue: "" },
      }),
    ).toBe(true);
  });

  // Anything else is malformed and treated as failure.
  it("returns false on a malformed response", () => {
    expect(checkTransactionResponse({})).toBe(false);
  });
});
