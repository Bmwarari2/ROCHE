/**
 * The app's translator. Care mode reads every word from the `@harbour/i18n` catalogues (the
 * `mobile.*` keys, plus shared keys such as `common.save`). English (en-GB) only until Welsh
 * tenants go live; the locale will then come from the tenant and the person's preference.
 *
 * Phase 0 screens (sign-in, lock, settings) still hold their English copy inline; moving them to
 * the catalogue is a follow-up.
 */
import { createTranslator, type MessageKey, type Translator } from "@harbour/i18n";

export const t: Translator = createTranslator("en-GB");

export type { MessageKey, Translator };
