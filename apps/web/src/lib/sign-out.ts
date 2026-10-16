import { clearContext } from "@/app/actions/context";
import { authClient } from "./auth-client";
import { forgetKeptToken } from "./invitations";

/**
 * Signs out in the browser and forgets the organisation, the location and any invitation link kept
 * while signing in first, so the next person on a shared computer starts afresh, then goes to the
 * sign-in page. Used by the account menu and the
 * choose-organisation page.
 */
export async function signOutAndForget(): Promise<void> {
  try {
    await authClient().signOut();
  } finally {
    forgetKeptToken();
    await clearContext().catch(() => undefined);
    window.location.assign("/sign-in");
  }
}
