"use client";

import { TabNav } from "@harbour/ui";
import Link from "next/link";
import { useEffect, useRef } from "react";
import type { RecordTab } from "@/lib/care-record";

export interface RecordTabItem {
  readonly tab: RecordTab;
  readonly href: string;
  readonly label: string;
}

/**
 * The sections of a person's record as tabs under the point-of-care header. Each tab is its own
 * page; the header stays above every one (HZ-001). On a phone the row scrolls so the current tab
 * is in view.
 */
export function RecordTabs({
  label,
  items,
  current,
}: {
  readonly label: string;
  readonly items: readonly RecordTabItem[];
  readonly current: RecordTab;
}) {
  const wrapper = useRef<HTMLDivElement>(null);

  // Each tab draws its own frame, so this runs once per tab: scroll the row sideways only, never
  // the page, so the current tab is visible on a phone.
  useEffect(() => {
    const list = wrapper.current?.querySelector<HTMLElement>(".hb-tabnav__list");
    const link = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!list || !link) return;
    const start = link.offsetLeft - list.offsetLeft;
    const end = start + link.offsetWidth;
    if (start < list.scrollLeft || end > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = Math.max(0, start - 16);
    }
  }, []);

  return (
    <div ref={wrapper}>
      <TabNav
        label={label}
        linkComponent={Link}
        items={items.map((item) => ({
          href: item.href,
          label: item.label,
          current: item.tab === current,
        }))}
      />
    </div>
  );
}
