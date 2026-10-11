import { describe, expect, it } from "vitest";
import { authMessages, signInErrorMessage } from "./auth-messages";

describe("signInErrorMessage", () => {
  it.each([
    [{ status: 401 }, authMessages.signInFailed],
    [{ status: 403 }, authMessages.signInFailed],
    [{ status: 429 }, authMessages.tooManyAttempts],
    [{ status: 502 }, authMessages.unreachable],
    [{}, authMessages.unreachable],
    [null, authMessages.signInFailed],
  ])("%j", (error, expected) => {
    expect(signInErrorMessage(error)).toBe(expected);
  });

  it("never blames the person", () => {
    for (const message of Object.values(authMessages)) {
      expect(message).not.toMatch(/\b(invalid|wrong|illegal|failed|error)\b/i);
    }
  });
});
