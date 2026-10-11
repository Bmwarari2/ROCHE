import { t } from "./i18n";

/**
 * Messages for sign-in and security set-up. Pure, unit tested. Strings without an i18n key yet are
 * listed for @harbour/i18n in the web app's hand-over notes.
 */

/** Plain-English messages for auth failures. They describe what happened, never blame the person. */
export const authMessages = {
  signInFailed: t("auth.signIn.failed"),
  tooManyAttempts: "There have been several attempts to sign in. Wait a minute, then try again.",
  unreachable: "Harbour could not reach the server. Check your connection and try again.",
  passkeyCancelled:
    "Signing in with a passkey did not finish. You can try again, or sign in with your email address and password.",
  passkeyUnsupported:
    "This browser cannot use passkeys. Sign in with your email address and password instead.",
  totpFailed: "That code did not match. Codes change every 30 seconds, so enter the latest one.",
} as const;

/** Picks the message for a Better Auth error response. */
export function signInErrorMessage(error: { status?: number } | null | undefined): string {
  if (!error) return authMessages.signInFailed;
  if (error.status === 429) return authMessages.tooManyAttempts;
  if (error.status === undefined || error.status === 0 || error.status >= 500) {
    return authMessages.unreachable;
  }
  return authMessages.signInFailed;
}
