import { catalogues, type MessageKey, type Translator } from "@harbour/i18n";
import { describe, expect, it } from "vitest";
import {
  type AuthMessages,
  authMessages,
  createAuthMessages,
  signInErrorMessage,
} from "./auth-messages";

const KEYS: Record<keyof AuthMessages, MessageKey> = {
  signInFailed: "auth.signIn.failed",
  tooManyAttempts: "auth.errors.tooManyAttempts",
  unreachable: "auth.errors.unreachable",
  passkeyCancelled: "auth.errors.passkeyCancelled",
  passkeyUnsupported: "auth.errors.passkeyUnsupported",
  passkeyNotAdded: "auth.errors.passkeyNotAdded",
  codeMismatch: "auth.errors.codeMismatch",
  passwordMismatch: "auth.errors.passwordMismatch",
};

/** A translator that shows which key was asked for, so tests prove nothing is hard-coded. */
const keyTranslator: Translator = Object.assign((key: MessageKey) => `[${key}]`, {
  locale: "cy" as const,
});

describe("signInErrorMessage", () => {
  it.each([
    [{ status: 401 }, authMessages.signInFailed],
    [{ status: 403 }, authMessages.signInFailed],
    [{ status: 429 }, authMessages.tooManyAttempts],
    [{ status: 502 }, authMessages.unreachable],
    [{ status: 0 }, authMessages.unreachable],
    [{}, authMessages.unreachable],
    [null, authMessages.signInFailed],
    [undefined, authMessages.signInFailed],
  ])("%j", (error, expected) => {
    expect(signInErrorMessage(error)).toBe(expected);
  });

  it("uses the messages it is given", () => {
    const messages = createAuthMessages(keyTranslator);
    expect(signInErrorMessage({ status: 429 }, messages)).toBe("[auth.errors.tooManyAttempts]");
    expect(signInErrorMessage({ status: 503 }, messages)).toBe("[auth.errors.unreachable]");
    expect(signInErrorMessage({ status: 401 }, messages)).toBe("[auth.signIn.failed]");
  });
});

describe("authMessages", () => {
  it.each(Object.entries(KEYS))("%s comes from %s in the catalogue", (name, key) => {
    expect(authMessages[name as keyof AuthMessages]).toBe(catalogues["en-GB"][key]);
    expect(createAuthMessages(keyTranslator)[name as keyof AuthMessages]).toBe(`[${key}]`);
  });

  it("keeps the English wording people and the journeys know", () => {
    expect(authMessages.unreachable).toBe(
      "Harbour could not reach the server. Check your connection and try again.",
    );
    expect(authMessages.codeMismatch).toBe(
      "That code did not match. Codes change every 30 seconds, so enter the latest one.",
    );
  });

  it("never blames the person", () => {
    for (const message of Object.values(authMessages)) {
      expect(message).not.toMatch(/\b(invalid|wrong|illegal|failed|error)\b/i);
    }
  });
});
