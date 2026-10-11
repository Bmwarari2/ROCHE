import { createTranslator, type Translator } from "@harbour/i18n";

/**
 * The web app's translator. English (en-GB) only until Welsh tenants go live (Phase 7); the locale
 * will then come from the tenant and the person's preference.
 *
 * Every word the web app shows comes from the `@harbour/i18n` catalogues (src/copy.test.ts fails
 * on literal copy in components). Server components call `t`. Client components that take a
 * `labels` prop get their words from the page that renders them; other client components, and
 * values only known in the browser (such as a character count), call `t` directly.
 */
export const t: Translator = createTranslator("en-GB");

export type Terminology = "resident" | "client" | "person_we_support";

/** "Residents", "Clients" or "People we support", from the tenant's terminology setting. */
export function peopleLabel(terminology: Terminology, translate: Translator = t): string {
  return translate("shell.nav.people", { terminology });
}

/**
 * The words under a text area with a maximum length: "You have 12 characters remaining", or
 * "You have 3 characters too many" when `remaining` is negative. For `TextArea`'s `formatCount`.
 */
export function characterCount(remaining: number, translate: Translator = t): string {
  return remaining >= 0
    ? translate("common.charactersRemaining", { count: remaining })
    : translate("common.charactersOver", { count: -remaining });
}
