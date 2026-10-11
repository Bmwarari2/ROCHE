import { IntlMessageFormat } from "intl-messageformat";
import cy from "./messages/cy.json" with { type: "json" };
import cyStatus from "./messages/cy.status.json" with { type: "json" };
import enGB from "./messages/en-GB.json" with { type: "json" };

/**
 * Message catalogues in ICU message format (section 5.4). English (en-GB) is the source; Welsh
 * (cy) has the same keys and is professionally translated before a Welsh tenant goes live
 * (Phase 7). Until then `cy.status.json` lists untranslated keys and they fall back to English.
 */

export const LOCALES = ["en-GB", "cy"] as const;
export type Locale = (typeof LOCALES)[number];

export type MessageKey = keyof typeof enGB;
export type Catalogue = Record<MessageKey, string>;

export const catalogues: Record<Locale, Catalogue> = { "en-GB": enGB, cy };

export const untranslatedWelshKeys: ReadonlySet<string> = new Set(cyStatus.untranslated);

export type MessageValues = Record<string, string | number | boolean | Date | null | undefined>;

export interface Translator {
  readonly locale: Locale;
  (key: MessageKey, values?: MessageValues): string;
}

export function createTranslator(locale: Locale): Translator {
  const cache = new Map<MessageKey, IntlMessageFormat>();
  const translate = (key: MessageKey, values?: MessageValues): string => {
    let formatter = cache.get(key);
    if (!formatter) {
      const useEnglish = locale === "cy" && untranslatedWelshKeys.has(key);
      const source = useEnglish ? enGB[key] : catalogues[locale][key];
      formatter = new IntlMessageFormat(source, useEnglish ? "en-GB" : locale);
      cache.set(key, formatter);
    }
    return String(formatter.format(values));
  };
  return Object.assign(translate, { locale });
}

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}
