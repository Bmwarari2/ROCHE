/**
 * Offline stand-in for the auth API in demo mode. Any email and password sign in; an email
 * containing "+totp" exercises the authenticator-code step, which accepts 123456.
 */
import { type AuthClient, AuthError, normaliseTotpCode } from "../auth/auth-client";
import { demoMe } from "./demo-data";

export const DEMO_TOKEN = "demo-session";
export const DEMO_TOTP_CODE = "123456";

export function createDemoAuthClient(): AuthClient {
  return {
    async signInWithEmail(email, password) {
      if (!email.trim() || !password) throw new AuthError("invalid_credentials");
      if (email.includes("+totp")) {
        return { kind: "two_factor_required", challenge: { cookie: "demo" } };
      }
      return { kind: "signed_in", token: DEMO_TOKEN };
    },
    async verifyTotp(_challenge, code) {
      if (normaliseTotpCode(code) !== DEMO_TOTP_CODE) throw new AuthError("invalid_code");
      return DEMO_TOKEN;
    },
    async signOut() {},
    async getMe() {
      return demoMe;
    },
  };
}
