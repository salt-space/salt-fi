import { ApiError } from "salt-sdk";
import { describe, expect, it } from "vitest";
import { formatSaltError } from "../src/errors.js";

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
