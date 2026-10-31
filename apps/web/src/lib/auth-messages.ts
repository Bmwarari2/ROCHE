import type { Translator } from "@harbour/i18n";
import { t } from "./i18n";

/**
 * Messages for sign-in and security set-up, from the `auth.*` catalogue keys. Pure, unit tested.
 * They describe what happened and what to do next, and never blame the person.
 */
export function createAuthMessages(translate: Translator) {
  return {
    signInFailed: translate("auth.signIn.failed"),
    tooManyAttempts: translate("auth.errors.tooManyAttempts"),
    unreachable: translate("auth.errors.unreachable"),
    passkeyCancelled: translate("auth.errors.passkeyCancelled"),
    passkeyUnsupported: translate("auth.errors.passkeyUnsupported"),
    passkeyNotAdded: translate("auth.errors.passkeyNotAdded"),
    codeMismatch: translate("auth.errors.codeMismatch"),
    backupCodeMismatch: translate("auth.errors.backupCodeMismatch"),
    passwordMismatch: translate("auth.errors.passwordMismatch"),
  } as const;
}

export type AuthMessages = ReturnType<typeof createAuthMessages>;

/** The web app's auth messages, in its locale. */
export const authMessages: AuthMessages = createAuthMessages(t);

/** Picks the message for a Better Auth error response. */
export function signInErrorMessage(
  error: { status?: number } | null | undefined,
  messages: AuthMessages = authMessages,
): string {
  if (!error) return messages.signInFailed;
  if (error.status === 429) return messages.tooManyAttempts;
  if (error.status === undefined || error.status === 0 || error.status >= 500) {
    return messages.unreachable;
  }
  return messages.signInFailed;
}
