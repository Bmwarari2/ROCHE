import { t } from "../i18n/t";

/**
 * Said when the keystore key no longer opens the database (biometrics or passcode changed): what
 * was on the phone cannot be read again, so it is replaced, and the notice says that entries not
 * yet sent may have been lost, never only that the data "was reset" (guides review, HZ-006).
 */
export function resetNoticeWords(heldEntries: number | null | undefined): string {
  return t("mobile.vault.resetNotice", {
    known: typeof heldEntries === "number" ? "yes" : "no",
    count: typeof heldEntries === "number" ? heldEntries : 0,
  });
}
