import { PageHeader } from "@harbour/ui";
import type { ReactNode } from "react";
import { DATA_RIGHTS_TABS, type DataRightsTab, TAB_PAGES } from "@/lib/data-rights";
import { t } from "@/lib/i18n";
import { DataRightsTabs } from "./DataRightsTabs";

/**
 * The frame of every data rights page: the heading, the tabs between the three registers, and the
 * page's content. Detail pages pass a back link and their own heading.
 */
export function DataRightsFrame({
  tab,
  title,
  description,
  eyebrow,
  children,
}: {
  readonly tab: DataRightsTab;
  readonly title: string;
  readonly description?: string;
  readonly eyebrow?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        title={title}
        {...(eyebrow ? { eyebrow } : {})}
        {...(description ? { description } : {})}
      />
      <DataRightsTabs
        label={t("dataRights.tabs")}
        current={tab}
        items={DATA_RIGHTS_TABS.map((key) => ({
          tab: key,
          href: TAB_PAGES[key],
          label: t("dataRights.tab", { tab: key }),
        }))}
      />
      {children}
    </div>
  );
}
