import Link from "next/link";
import { longerWindow, type ReadingWindow } from "@/lib/care-record";
import { t } from "@/lib/i18n";

/**
 * Says how far back a list reads and offers a longer window. Lists stay short (the API's default
 * is three days), which keeps pages fast; older entries are one link away.
 */
export function WindowNote({
  days,
  href,
}: {
  readonly days: ReadingWindow;
  readonly href: string;
}) {
  const longer = longerWindow(days);
  const separator = href.includes("?") ? "&" : "?";
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-4 gap-y-1 text-callout text-text-secondary">
      <span>{t("care.entry.window", { days })}</span>
      {longer ? (
        <Link href={`${href}${separator}days=${longer}`} className="hb-button hb-button--tertiary">
          <span className="hb-button__label">{t("care.entry.showMore", { days: longer })}</span>
          <span className="hb-button__chevron" aria-hidden="true">
            ›
          </span>
        </Link>
      ) : null}
    </p>
  );
}
