/**
 * Intl features the message catalogues need and Hermes lacks.
 *
 * `@harbour/i18n` formats ICU messages with intl-messageformat, which selects plural forms with
 * `Intl.PluralRules`. Hermes on iOS has neither `Intl.PluralRules` nor `Intl.Locale` (which the
 * PluralRules polyfill builds on), so the first plural message threw ("Intl.PluralRules is not
 * available in this environment") and Today could not open on an iPhone. Node has both, which is
 * why the unit tests never saw it. Android's Hermes is assumed to lack them too until a device run
 * proves otherwise: each polyfill installs itself only where the engine's own is missing or
 * incomplete, so loading them everywhere costs nothing where they are not needed.
 *
 * Order matters: `Intl.Locale` first, then `Intl.PluralRules`, then its locale data for every
 * locale the app can show (en-GB resolves to `en`; Welsh, `cy`, has six plural forms).
 *
 * Imported first by the app entry (`index.ts`), before expo-router loads any screen.
 */
import "@formatjs/intl-locale/polyfill.js";
import "@formatjs/intl-pluralrules/polyfill.js";
import "@formatjs/intl-pluralrules/locale-data/en.js";
import "@formatjs/intl-pluralrules/locale-data/cy.js";
