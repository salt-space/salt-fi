import { describe, expect, it } from "vitest";
import { createdAtFromId } from "../src/commands/organisations.js";

/** An ObjectId-shaped id whose first 4 bytes are `date` in Unix seconds. */
const idAt = (date: Date) => Math.floor(date.getTime() / 1000).toString(16).padStart(8, "0") + "0123456789abcdef";

describe("createdAtFromId", () => {
  it("reads the creation time from an ObjectId", () => {
    const when = new Date(Date.UTC(2026, 9, 14, 14, 48));
    expect(createdAtFromId(idAt(when))?.toISOString()).toBe(when.toISOString());
  });

  it("accepts upper-case hex", () => {
    const when = new Date(Date.UTC(2025, 2, 1));
    expect(createdAtFromId(idAt(when).toUpperCase())?.getTime()).toBe(when.getTime());
  });

  it("gives no date for an id that isn't an ObjectId", () => {
    expect(createdAtFromId("org-123")).toBeUndefined();
    expect(createdAtFromId("6acf96200123456789abcde")).toBeUndefined(); // 23 characters
  });

  it("gives no date for an implausible time", () => {
    expect(createdAtFromId("000000000000000000000000")).toBeUndefined(); // 1970
    expect(createdAtFromId("ffffffff0000000000000000")).toBeUndefined(); // 2106
  });
});
