import {
  ApiError,
  BroadcastRejectedError,
  InsufficientPermissions,
  KeyshareBackupUnavailableError,
  PaymentAuthorisationError,
  PolicyBreachError,
  RoboStatusError,
  TransactionPendingError,
  TransactionReplacedError,
  TransactionRevertedError,
  type Policy,
} from "salt-sdk";
import type { TransactionReceipt } from "viem";
import { describe, expect, it } from "vitest";
import { formatSaltError, txHashFromError } from "../src/errors.js";

describe("formatSaltError · ApiError", () => {
  const url = "https://app.salt.space/api/accounts";

  it("shows what the body says beyond the message", () => {
    const err = new ApiError(400, { message: "Invalid payload structure", errors: [{ path: ["signers", 2], message: "Invalid address" }] }, url, "POST");
    expect(formatSaltError(err)).toBe(
      `API error: POST ${url} Invalid payload structure\n{"errors":[{"path":["signers",2],"message":"Invalid address"}]}`,
    );
  });

  it("adds the error code when there is one", () => {
    const err = new ApiError(400, { message: "Nope", code: "INVALID_PAYLOAD" }, url, "POST");
    expect(formatSaltError(err)).toBe(`API error: POST ${url} Nope [INVALID_PAYLOAD]`);
  });

  it("stays a single line when the body has nothing more", () => {
    expect(formatSaltError(new ApiError(400, { message: "Invalid payload structure" }, url, "POST"))).toBe(
      `API error: POST ${url} Invalid payload structure`,
    );
    expect(formatSaltError(new ApiError(502, "<html>Bad gateway</html>", url, "POST"))).toBe(
      `API error: POST ${url} Request failed with status 502`,
    );
  });

  it("says how to pay when Salt asks for a fee (402)", () => {
    const err = new ApiError(402, { message: "Payment required before creating an account" }, url, "POST");
    expect(formatSaltError(err)).toBe(
      `Salt charges a fee for this, and it wasn't paid (POST ${url} Payment required before creating an account). ` +
        'Choose who pays under Fees (x402) → "Choose who pays", or set SALT_FEE_PAYER in .env (see "Fees (x402)" in the README).',
    );
  });
});

describe("formatSaltError · InsufficientPermissions", () => {
  const url = "https://testnet.salt.space/api/organisations/org-id/accounts";

  it("says you're suspended when Salt names the suspension", () => {
    // The reason newer Salt API releases give.
    const err = new InsufficientPermissions({ code: 403, message: "unauthorized:suspended" }, url, "GET");
    expect(formatSaltError(err)).toMatch(/^You're suspended in this organisation/);
  });

  it("points a suspended collaborator at the suspension, not their access level", () => {
    // The body Salt sends a suspended collaborator (seen on testnet, 2026-10-25).
    const err = new InsufficientPermissions({ code: 403, message: "unauthorized:no-role" }, url, "GET");
    expect(formatSaltError(err)).toMatch(/^Salt says you have no active role in this organisation, which usually means you've been suspended/);
  });

  it("keeps the access-level message for other refusals", () => {
    const err = new InsufficientPermissions({ code: 403, message: "unauthorized" }, url, "POST");
    expect(formatSaltError(err)).toBe("Your access level in this organisation doesn't permit that action.");
  });
});

const HASH = `0x${"ab".repeat(32)}` as const;

describe("txHashFromError", () => {
  it("follows a pending transaction by its hash", () => {
    expect(txHashFromError(new TransactionPendingError(421614, HASH))).toBe(HASH);
  });

  it("returns nothing for a settled transaction, though its message names the hash", () => {
    const receipt = { transactionHash: HASH, blockNumber: 1n, status: "reverted" } as TransactionReceipt;
    for (const err of [
      new BroadcastRejectedError(421614, HASH),
      new TransactionReplacedError(421614, HASH),
      new TransactionRevertedError(receipt),
    ]) {
      expect(err.message).toContain(HASH);
      expect(txHashFromError(err)).toBeUndefined();
    }
  });

  it("still finds the hash in a receipt timeout from outside the SDK", () => {
    expect(txHashFromError(new Error(`Timed out while waiting for transaction with hash "${HASH}" to be confirmed.`))).toBe(HASH);
  });
});

describe("formatSaltError · salt-sdk 0.0.45 errors", () => {
  const policy = (type: Policy["type"]): Policy =>
    ({ id: "policy-id", type, chain: "*", accountId: "account-id", organisationId: "org-id", params: { recipients: [] } }) as Policy;

  it("names the message policy when it blocks a signature", () => {
    expect(formatSaltError(new PolicyBreachError([policy("denied_message_proposers")]))).toMatch(
      /^Message signing is blocked by this account's "Denied message proposers" policy\./,
    );
  });

  it("lists the transaction policies that block a transaction", () => {
    expect(formatSaltError(new PolicyBreachError([policy("allowed_recipients"), policy("allowed_recipients")]))).toBe(
      'Blocked by this account\'s policies: Allowed recipients (whitelist). An owner can change them under Policies → "Manage policies".',
    );
  });

  it("says a refused broadcast is safe to submit again", () => {
    expect(formatSaltError(new BroadcastRejectedError(421614, HASH))).toMatch(/Submitting it again is safe/);
  });

  it("explains a keyshare backup Salt can't pay for", () => {
    expect(formatSaltError(new KeyshareBackupUnavailableError({ errorCode: "KEYSHARE_BACKUP_UNAVAILABLE" }))).toMatch(
      /^Salt can't back up new accounts' key shares right now/,
    );
  });

  it("tells a failed fee payment apart from the operation, with the payer's own reason", () => {
    const cause = new RoboStatusError("robo quorum not met");
    expect(formatSaltError(new PaymentAuthorisationError("0xpayer", undefined, cause))).toBe(
      "The fee payer (0xpayer) couldn't sign Salt's fee, so nothing was created and starting again is a clean retry.\n" +
        formatSaltError(cause),
    );
  });
});
