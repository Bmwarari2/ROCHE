/**
 * What was typed at the second sign-in step: a 6-digit code from the authenticator app, or one of
 * the backup codes given when the app was set up (each works once). Spaces are ignored; anything
 * else is neither, so the form asks again in words.
 */
export type SignInCode =
  | { readonly kind: "totp"; readonly code: string }
  | { readonly kind: "backup"; readonly code: string };

/** The longest code the field takes (a backup code with its hyphen). */
export const SIGN_IN_CODE_MAX_LENGTH = 24;

export function readSignInCode(typed: string): SignInCode | null {
  const code = typed.replace(/\s+/g, "");
  if (/^\d{6}$/.test(code)) return { kind: "totp", code };
  if (/^[A-Za-z0-9]{4,}(-[A-Za-z0-9]{4,})*$/.test(code) && code.replace(/-/g, "").length >= 8) {
    return { kind: "backup", code };
  }
  return null;
}
