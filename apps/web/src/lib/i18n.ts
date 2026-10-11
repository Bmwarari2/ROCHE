import { createTranslator, type Translator } from "@harbour/i18n";

/**
 * The web app's translator. English (en-GB) only until Welsh tenants go live (Phase 7); the locale
 * will then come from the tenant and the person's preference.
 */
export const t: Translator = createTranslator("en-GB");

export type Terminology = "resident" | "client" | "person_we_support";

/** "Residents", "Clients" or "People we support", from the tenant's terminology setting. */
export function peopleLabel(terminology: Terminology): string {
  return t("shell.nav.people", { terminology });
}
