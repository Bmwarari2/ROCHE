"use client";

import { TabNav } from "@harbour/ui";
import Link from "next/link";
import type { DataRightsTab } from "@/lib/data-rights";

/** The three data rights registers as tabs; each is a page of its own. */
export function DataRightsTabs({
  label,
  items,
  current,
}: {
  readonly label: string;
  readonly items: readonly {
    readonly tab: DataRightsTab;
    readonly href: string;
    readonly label: string;
  }[];
  readonly current: DataRightsTab;
}) {
  return (
    <TabNav
      label={label}
      linkComponent={Link}
      items={items.map((item) => ({
        href: item.href,
        label: item.label,
        current: item.tab === current,
      }))}
    />
  );
}
