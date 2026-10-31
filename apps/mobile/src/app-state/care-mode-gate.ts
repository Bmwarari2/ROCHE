/**
 * Care mode on the phone is a control, not an instruction (H-381): until a clinical safety case
 * covers the app, the organisation's flag `care.mobile_care_mode` stays off and the phone refuses
 * Care mode sign-in, as the API refuses its sync token and uploads. The demonstration build, with
 * invented data only, is not refused. A phone that holds unsent entries still lets someone sign
 * in, so their owner or a manager can hand them over or record their deletion under the hold
 * rules; the API then refuses the sync token, so nothing new reaches the phone.
 */
import { CARE_MODE_FLAG } from "@harbour/domain";
import type { Me } from "../auth/auth-client";
import { t } from "../i18n/t";

/** Whether the organisation has switched Care mode on for phones. */
export function careModeOn(me: Pick<Me, "flags">, demoMode: boolean): boolean {
  return demoMode || me.flags?.[CARE_MODE_FLAG] === true;
}

/** The sign-in was refused because Care mode is off for the organisation. */
export class CareModeOffError extends Error {
  constructor() {
    super(t("mobile.signIn.careModeOff"));
    this.name = "CareModeOffError";
  }
}

/**
 * Admits a sign-in to Care mode: refused, with the new session ended, while the organisation has
 * Care mode off and the phone holds no unsent entries.
 */
export async function admitCareMode(deps: {
  readonly me: Pick<Me, "flags">;
  readonly demoMode: boolean;
  readonly holdsEntries: boolean;
  readonly token: string;
  readonly signOut: (token: string) => Promise<void>;
}): Promise<void> {
  if (careModeOn(deps.me, deps.demoMode) || deps.holdsEntries) return;
  await deps.signOut(deps.token).catch(() => undefined);
  throw new CareModeOffError();
}
