import { ButtonLink } from "@harbour/ui";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { TASK_PAGE_SIZE as pageSize } from "@/lib/tasks";

/**
 * A page of a task list: the first `shown` tasks, how many of how many are shown, and a link for
 * the next page (an address of its own, so it works without scripts and keeps its place). The
 * page stays quick however many tasks are open (section 5 budgets).
 */
export function TaskPage<T>({
  items,
  shown,
  moreHref,
  render,
}: {
  readonly items: readonly T[];
  readonly shown: number;
  readonly moreHref: string;
  readonly render: (item: T) => ReactNode;
}) {
  const visible = items.slice(0, shown);
  const more = items.length - visible.length;
  return (
    <div className="flex flex-col gap-3">
      <ul className="m-0 flex list-none flex-col gap-4 p-0">{visible.map(render)}</ul>
      {more > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="m-0 text-body-dense">
            {t("tasks.page.showing", { shown: visible.length, total: items.length })}
          </p>
          <ButtonLink
            href={moreHref}
            variant="secondary"
            icon={<ChevronDown size={18} strokeWidth={1.5} aria-hidden="true" />}
          >
            {t("tasks.page.more", { count: Math.min(more, pageSize) })}
          </ButtonLink>
        </div>
      ) : null}
    </div>
  );
}
