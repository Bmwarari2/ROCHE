import "server-only";
import type { Metadata } from "next";
import { getShellContext } from "./api";
import type { RecordTab } from "./care-record";
import { peopleLabel, t } from "./i18n";

/**
 * The page title of a tab of a person's record: "Charts | Residents | Harbour", or with the part
 * of the tab shown, "Vital signs | Charts | Residents | Harbour". A new title on every tab means
 * Next.js announces the change of page to screen reader users (WCAG 2.4.2 and 4.1.3).
 *
 * The title never names the person: browser history and tab titles are visible to whoever uses
 * the computer next.
 */
export async function recordMetadata(tab: RecordTab, section?: string): Promise<Metadata> {
  const { me } = await getShellContext();
  const title = t("care.title.tab", {
    tab: t(`care.tabs.${tab}`),
    people: peopleLabel(me.tenant.terminology),
  });
  return { title: section ? t("care.title.section", { section, title }) : title };
}

/** The first value of a search parameter. */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
