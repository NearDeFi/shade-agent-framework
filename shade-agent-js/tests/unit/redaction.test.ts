/**
 * Per-call-site redaction fuzz suite.
 *
 * Verifies that every wrapped function in shade-agent-js propagates errors
 * through `toThrowable` — by injecting a simulated leak into each function's
 * dependency error and asserting the rethrown error contains no substring of
 * the test secret. The marker `ZZTESTSECRET` makes any leak easy to spot.
 *
 * This is the gating check on the sanitise-everywhere refactor: if it passes,
 * sanitisation is correctly wired at every call site. If a test fails, either
 * the redact list needs extending (extend `SHADE_REDACT_KEYS` /
 * `SHADE_REDACT_PATTERNS` in `errors.ts`) or the call site has bypassed
 * `toThrowable` (fix the wrapper).
 */

import { describe, it, expect, vi } from "vitest";
import {
  internalFundAgent,
  addKeysToAccount,
  removeKeysFromAccount,
  createAccountObject,
} from "../../src/utils/near";
import {
  transformQuote,
  transformCollateral,
  transformTcbInfo,
  attestationForContract,
} from "../../src/utils/attestation-transform";
import { internalGetAttestation } from "../../src/utils/tee";
import { generateAgent } from "../../src/utils/agent";
import { createMockAccount, createMockProvider } from "../mocks";
import { createMockDstackClient } from "../mocks/tee-mocks";
import { generateTestKey } from "../test-utils";

vi.mock("@near-js/accounts", async () => {
  const actual = await vi.importActual<typeof import("@near-js/accounts")>(
    "@near-js/accounts",
  );
  return {
    ...actual,
    Account: vi.fn(function (this: any, accountId: string) {
      this.accountId = accountId;
      this.transfer = vi.fn();
    }),
  };
});

// Bypass the retry layer inside tee.ts/agent.ts for faster fuzz runs.
vi.mock("../../src/utils/errors", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("../../src/utils/errors");
  return {
    ...actual,
    withRetry: <T,>(fn: () => Promise<T>) => fn(),
  };
});

// The fuzz markers — every leak shape embeds one so we can scan for any
// that escaped redaction.
const MARKERS = {
  ed25519: "ZZTESTSECRETZZed",
  secp256k1: "ZZTESTSECRETZZsecp",
  raw: "ZZTESTSECRETZZraw",
  pem: "ZZTESTSECRETZZpem",
  xprv: "ZZTESTSECRETZZxprv",
  wif: "ZZTESTSECRETZZwif",
  mnemonic: "ZZTESTSECRETZZmnemonic",
  cause: "ZZTESTSECRETZZcause",
  custom: "ZZTESTSECRETZZcustom",
} as const;

function makeLeakError(kind: keyof typeof MARKERS): Error {
  switch (kind) {
    case "ed25519":
      return new Error(`signed with key ed25519:${MARKERS.ed25519}`);
    case "secp256k1":
      return new Error(`signed with secp256k1:${MARKERS.secp256k1}`);
    case "raw":
      return Object.assign(new Error("auth failed"), {
        extendedSecretKey: MARKERS.raw,
      });
    case "pem":
      return new Error(
        `loaded -----BEGIN RSA PRIVATE KEY-----\n${MARKERS.pem}\n-----END RSA PRIVATE KEY-----`,
      );
    case "xprv":
      return new Error(
        `derived from xprv9s21ZrQH143K3${MARKERS.xprv}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
      );
    case "wif": {
      // WIF regex requires 50–51 base58 chars after the leading 5/K/L.
      const padded = (MARKERS.wif + "x".repeat(50)).slice(0, 50);
      return new Error(`wif 5${padded}`);
    }
    case "mnemonic":
      return Object.assign(new Error("bad seed"), {
        mnemonic: `${MARKERS.mnemonic} abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about`,
      });
    case "cause":
      return Object.assign(new Error("inner"), {
        cause: {
          signer: {
            key: { extendedSecretKey: `ed25519:${MARKERS.cause}` },
          },
        },
      });
    case "custom":
      return Object.assign(new Error("upstream failure"), {
        accountConfig: {
          signer: { secretKey: MARKERS.custom },
        },
      });
  }
}

async function assertNoLeak(
  invoke: () => Promise<unknown>,
  marker: string,
): Promise<void> {
  let captured: unknown = null;
  try {
    await invoke();
  } catch (e) {
    captured = e;
  }
  expect(captured).toBeInstanceOf(Error);
  const err = captured as Error;

  // Serialise everything reachable from the error: message, own props, cause.
  const seen: unknown[] = [];
  const serialise = (v: unknown): string => {
    try {
      return JSON.stringify(v, (_k, val) => {
        if (typeof val === "object" && val !== null) {
          if (seen.includes(val)) return "[CIRCULAR]";
          seen.push(val);
        }
        return val;
      });
    } catch {
      return String(v);
    }
  };
  const haystack =
    `${err.message ?? ""} ` +
    `${serialise(err)} ` +
    `${serialise({ ...err })} ` +
    `${serialise((err as Error & { cause?: unknown }).cause)}`;

  // Specific marker for this case
  expect(haystack).not.toContain(marker);
  // Catch-all guard — any marker substring whatsoever is a failure
  expect(haystack).not.toContain("ZZTESTSECRET");
}

const LEAK_KINDS = Object.keys(MARKERS) as (keyof typeof MARKERS)[];

function syncInvoke(fn: () => unknown) {
  return async () => fn();
}

// --- near.ts ----------------------------------------------------------------

describe("redaction: near.ts", () => {
  describe("internalFundAgent", () => {
    it.each(LEAK_KINDS)(
      "redacts %s leak from account.transfer",
      async (kind) => {
        const account = createMockAccount();
        (account.transfer as ReturnType<typeof vi.fn>).mockRejectedValue(
          makeLeakError(kind),
        );
        // Patch the @near-js/accounts mock so internalFundAgent's
        // `new Account(...)` returns our prepared mock.
        const { Account } = await import("@near-js/accounts");
        vi.mocked(Account).mockImplementationOnce(function (this: any) {
          Object.assign(this, account);
          return this;
        });

        await assertNoLeak(
          () =>
            internalFundAgent(
              "agent.testnet",
              "sponsor.testnet",
              generateTestKey("sponsor-key"),
              1,
              createMockProvider(),
            ),
          MARKERS[kind],
        );
      },
    );
  });

  describe("addKeysToAccount", () => {
    it.each(LEAK_KINDS)(
      "redacts %s leak from signAndSendTransaction",
      async (kind) => {
        const account = createMockAccount();
        (
          account.signAndSendTransaction as ReturnType<typeof vi.fn>
        ).mockRejectedValue(makeLeakError(kind));
        await assertNoLeak(
          () => addKeysToAccount(account, [generateTestKey("k")]),
          MARKERS[kind],
        );
      },
    );
  });

  describe("removeKeysFromAccount", () => {
    it.each(LEAK_KINDS)(
      "redacts %s leak from signAndSendTransaction",
      async (kind) => {
        const account = createMockAccount();
        (
          account.signAndSendTransaction as ReturnType<typeof vi.fn>
        ).mockRejectedValue(makeLeakError(kind));
        await assertNoLeak(
          () => removeKeysFromAccount(account, [generateTestKey("k")]),
          MARKERS[kind],
        );
      },
    );
  });

  describe("createAccountObject", () => {
    it.each(LEAK_KINDS)(
      "redacts %s leak from Account constructor",
      async (kind) => {
        const { Account } = await import("@near-js/accounts");
        vi.mocked(Account).mockImplementationOnce(() => {
          throw makeLeakError(kind);
        });
        await assertNoLeak(
          syncInvoke(() =>
            createAccountObject("agent.testnet", createMockProvider()),
          ),
          MARKERS[kind],
        );
      },
    );
  });
});

// --- agent.ts ---------------------------------------------------------------

describe("redaction: agent.ts", () => {
  describe("generateAgent (TEE path)", () => {
    it.each(LEAK_KINDS)(
      "redacts %s leak from dstackClient.getKey",
      async (kind) => {
        const client = createMockDstackClient();
        (client.getKey as ReturnType<typeof vi.fn>).mockRejectedValue(
          makeLeakError(kind),
        );
        await assertNoLeak(
          () => generateAgent(client, undefined),
          MARKERS[kind],
        );
      },
    );
  });
});

// --- tee.ts -----------------------------------------------------------------

describe("redaction: tee.ts", () => {
  const mockFetch = vi.fn();
  globalThis.fetch = mockFetch;

  describe("internalGetAttestation (info path)", () => {
    it.each(LEAK_KINDS)(
      "redacts %s leak from dstackClient.info()",
      async (kind) => {
        const client = createMockDstackClient();
        (client.info as ReturnType<typeof vi.fn>).mockRejectedValue(
          makeLeakError(kind),
        );
        await assertNoLeak(
          () => internalGetAttestation(client, "agent.testnet", true),
          MARKERS[kind],
        );
      },
    );
  });

  describe("internalGetAttestation (getQuote path)", () => {
    it.each(LEAK_KINDS)(
      "redacts %s leak from dstackClient.getQuote()",
      async (kind) => {
        const client = createMockDstackClient();
        (client.getQuote as ReturnType<typeof vi.fn>).mockRejectedValue(
          makeLeakError(kind),
        );
        await assertNoLeak(
          () => internalGetAttestation(client, "agent.testnet", true),
          MARKERS[kind],
        );
      },
    );
  });

  describe("internalGetAttestation (fetch path)", () => {
    it.each(LEAK_KINDS)(
      "redacts %s leak from fetch()",
      async (kind) => {
        const client = createMockDstackClient();
        mockFetch.mockRejectedValue(makeLeakError(kind));
        await assertNoLeak(
          () => internalGetAttestation(client, "agent.testnet", true),
          MARKERS[kind],
        );
      },
    );
  });
});

// --- attestation-transform.ts -----------------------------------------------

describe("redaction: attestation-transform.ts", () => {
  describe("transformQuote", () => {
    it.each(LEAK_KINDS)(
      "redacts %s leak when Buffer.from throws",
      async (kind) => {
        const spy = vi
          .spyOn(Buffer, "from")
          .mockImplementationOnce(() => {
            throw makeLeakError(kind);
          });
        await assertNoLeak(
          syncInvoke(() => transformQuote("0xdeadbeef")),
          MARKERS[kind],
        );
        spy.mockRestore();
      },
    );
  });

  describe("transformCollateral", () => {
    it.each(LEAK_KINDS)(
      "redacts %s leak when hex decode throws",
      async (kind) => {
        const spy = vi
          .spyOn(Buffer, "from")
          .mockImplementation(() => {
            throw makeLeakError(kind);
          });
        await assertNoLeak(
          syncInvoke(() => transformCollateral({ root_ca_crl: "deadbeef" })),
          MARKERS[kind],
        );
        spy.mockRestore();
      },
    );
  });

  describe("transformTcbInfo", () => {
    it.each(LEAK_KINDS)(
      "redacts %s leak when event_log map throws",
      async (kind) => {
        const bad = {
          mrtd: "x",
          rtmr0: "x",
          rtmr1: "x",
          rtmr2: "x",
          rtmr3: "x",
          os_image_hash: "x",
          compose_hash: "x",
          device_id: "x",
          app_compose: "x",
          // Trigger the throw by giving event_log a Proxy that throws on iteration.
          event_log: new Proxy([] as unknown[], {
            get(target, prop) {
              if (prop === "map") {
                return () => {
                  throw makeLeakError(kind);
                };
              }
              return (target as any)[prop];
            },
          }) as any,
        };
        await assertNoLeak(
          syncInvoke(() => transformTcbInfo(bad as any)),
          MARKERS[kind],
        );
      },
    );
  });

  describe("attestationForContract", () => {
    it.each(LEAK_KINDS)(
      "redacts %s leak when bytesToHex path throws",
      async (kind) => {
        // Pass an attestation whose `collateral.root_ca_crl` is a value that
        // makes Buffer.from throw on access.
        const bad = {
          quote: [],
          collateral: new Proxy(
            {} as any,
            {
              get(_target, prop) {
                if (prop === "pck_crl_issuer_chain") return "";
                throw makeLeakError(kind);
              },
            },
          ),
          tcb_info: {} as any,
        };
        await assertNoLeak(
          syncInvoke(() => attestationForContract(bad as any)),
          MARKERS[kind],
        );
      },
    );
  });
});
