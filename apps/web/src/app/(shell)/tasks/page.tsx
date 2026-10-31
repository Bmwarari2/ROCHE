import type { PersonSummary, TaskItem } from "@harbour/contracts";
import { ButtonLink, Card, EmptyState, PageHeader, StatusChip, TabNav } from "@harbour/ui";
import { Flag, ListChecks, SearchCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { TaskEvidenceBadge } from "@/components/care/LifecycleBadges";
import { TaskDetails } from "@/components/care/TaskDetails";
import { PersonNeeds } from "@/components/safety/PersonNeeds";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { NewTaskForm } from "@/components/tasks/NewTaskForm";
import { TaskActions } from "@/components/tasks/TaskActions";
import { TaskPage } from "@/components/tasks/TaskPage";
import { failWith, getShellContext, tenantApi } from "@/lib/api";
import { isFamilyMember } from "@/lib/family-feed";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";
import { firstParam } from "@/lib/record-metadata";
import {
  isOpen,
  isReviewTask,
  onlyReviews,
  shownCount,
  sortTasks,
  splitByWindow,
  TASK_MANAGE,
  TASK_PAGE_SIZE,
  type TasksQuery,
  taskChip,
  tasksHref,
  tasksQuery,
  taskWindow,
} from "@/lib/tasks";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("tasks.title") };

const DONE = new Set([
  "started",
  "done",
  "skipped",
  "cancelled",
  "assigned",
  "unassigned",
  "created",
  "scheduled",
]);

/** A filter as a link that says whether it is the one shown (aria-current), never by colour. */
function FilterLink({
  href,
  current,
  children,
}: {
  readonly href: string;
  readonly current: boolean;
  readonly children: string;
}) {
  return (
    <ButtonLink
      href={href}
      variant={current ? "primary" : "secondary"}
      aria-current={current ? "true" : undefined}
    >
      {children}
    </ButtonLink>
  );
}

/**
 * Tasks (PLAT-011; platform.md, task and workflow engine; HZ-003, HZ-004, HZ-006, HZ-008): "My
 * tasks" and "Team tasks", open or finished, for yesterday to tomorrow or the week either side.
 * Each task says where it stands with an icon and a word, who it is about and assigned to, when it
 * is due in UK time, and for a review raised by the engine (an entry that did not complete its
 * round, a late entry, a stale write) what it lists. Managers create, schedule, take and unassign
 * tasks. The API decides what each person sees and may do.
 */
export default async function TasksPage({ searchParams }: { readonly searchParams: SearchParams }) {
  const { me, locationId } = await getShellContext();
  const title = t("tasks.title");
  if (isFamilyMember(me)) return <SafetyForbidden title={title} />;
  const query: TasksQuery = tasksQuery(await searchParams);
  const raw = await searchParams;
  const here = tasksHref(query);
  const { from, to } = taskWindow(query.range, new Date());
  const api = await tenantApi();
  const listed = await api.GET("/v1/tasks", {
    params: {
      query: {
        view: query.view === "mine" ? "mine" : "all",
        status: query.status,
        // Open tasks due before the window stay listed, however old (HZ-003, HZ-008).
        ...(query.status === "open" ? { earlier: "yes" as const } : {}),
        from,
        to,
      },
    },
  });
  if (!listed.data) failWith(listed.error, listed.response, here);
  const all = sortTasks(listed.data.items);
  const items = query.reviews ? onlyReviews(all) : all;
  // The window's own tasks first; open tasks due before it in a section of their own, so old open
  // tasks never push today's out of sight (HZ-003). Each renders a page at a time.
  const { inWindow: windowItems, earlier: earlierItems } = splitByWindow(items, from);
  const earlierOmitted = listed.data.earlierOmitted ?? 0;
  const show = shownCount(raw.show);
  const showEarlier = shownCount(raw.showEarlier);
  const moreHref = (key: "show" | "showEarlier", current: number) => {
    const url = new URL(here, "http://harbour.invalid");
    if (show !== TASK_PAGE_SIZE) url.searchParams.set("show", String(show));
    if (showEarlier !== TASK_PAGE_SIZE) url.searchParams.set("showEarlier", String(showEarlier));
    url.searchParams.set(key, String(current + TASK_PAGE_SIZE));
    return `${url.pathname}${url.search}#${key === "show" ? "task-list" : "task-list-earlier"}`;
  };
  const visible = [...windowItems.slice(0, show), ...earlierItems.slice(0, showEarlier)];

  // People's names, when the viewer may open their records; otherwise the task says "a person".
  const people = new Map<string, PersonSummary>();
  if (me.permissions.includes("people.person.read") && visible.some((i) => i.personId)) {
    const listedPeople = await api.GET("/v1/people", {}).catch(() => null);
    for (const p of listedPeople?.data?.items ?? []) people.set(p.id, p);
  }
  const readAt = formatDateTime(new Date().toISOString()) ?? "";
  const locations = new Map(me.locations.map((l) => [l.id, l.name]));
  const mayManage = me.permissions.includes(TASK_MANAGE);
  const done = firstParam(raw.done);
  const when = (iso: string | null) => formatDateTime(iso) ?? "";

  const renderTask = (task: TaskItem) => {
    const review = isReviewTask(task);
    const person = task.personId ? people.get(task.personId) : undefined;
    return (
      <li
        key={task.id}
        data-task-id={task.id}
        className="flex flex-col gap-2 border-b border-border pb-4"
      >
        <h3 id={`task-${task.id}`} className="m-0 text-body font-semibold">
          {task.title}
        </h3>
        <p className="m-0 flex flex-wrap items-center gap-2">
          <SafetyChip chip={taskChip(task, t)} />
          {task.priority === "urgent" ? (
            <StatusChip status="overdue" label={t("tasks.flag.urgent")} icon={Flag} />
          ) : null}
          {review ? (
            <StatusChip status="info" label={t("tasks.flag.review")} icon={SearchCheck} />
          ) : null}
          <TaskEvidenceBadge task={task} />
        </p>
        <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1 text-body-dense sm:grid-cols-[max-content_1fr]">
          {task.personId ? (
            <>
              <dt className="font-semibold">{t("tasks.item.about")}</dt>
              <dd className="m-0">
                {person ? (
                  <div className="flex flex-col gap-1">
                    {/* A 44 px target on its own line (section 8; MOB-013 at 360 px). */}
                    <Link
                      href={`/people/${task.personId}`}
                      className="inline-flex min-h-target items-center self-start"
                    >
                      {personNames(person).full}
                    </Link>
                    <PersonNeeds person={person} />
                  </div>
                ) : (
                  t("tasks.item.aPerson")
                )}
              </dd>
            </>
          ) : null}
          {task.locationId && locations.get(task.locationId) ? (
            <>
              <dt className="font-semibold">{t("tasks.item.where")}</dt>
              <dd className="m-0">{locations.get(task.locationId)}</dd>
            </>
          ) : null}
          <dt className="font-semibold">{t("tasks.item.due")}</dt>
          <dd className="m-0 tabular-nums">
            {task.windowStart && task.windowEnd && task.windowStart !== task.windowEnd
              ? t("tasks.item.window", {
                  from: when(task.windowStart),
                  to: when(task.windowEnd),
                })
              : when(task.dueAt)}
          </dd>
          <dt className="font-semibold">{t("tasks.item.assigned")}</dt>
          <dd className="m-0">
            {task.assigneeStaff
              ? task.assigneeStaff.id === me.tenantUserId
                ? t("tasks.item.you")
                : task.assigneeStaff.displayName
              : task.assigneeTenantUserId === me.tenantUserId
                ? t("tasks.item.you")
                : t("tasks.item.unassigned")}
          </dd>
          {task.completedAt ? (
            <>
              <dt className="font-semibold">{t("tasks.item.completed")}</dt>
              <dd className="m-0">
                {task.completedByStaff
                  ? t("tasks.item.completedBy", {
                      name: task.completedByStaff.displayName,
                      dateTime: when(task.completedAt),
                    })
                  : when(task.completedAt)}
              </dd>
            </>
          ) : null}
          {task.statusReason ? (
            <>
              <dt className="font-semibold">{t("tasks.item.reason")}</dt>
              <dd className="m-0">{task.statusReason}</dd>
            </>
          ) : null}
        </dl>
        <TaskDetails details={task.details} />
        {isOpen(task) ? (
          <TaskActions task={task} returnTo={here} selfId={me.tenantUserId} mayManage={mayManage} />
        ) : null}
      </li>
    );
  };

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader eyebrow={me.tenant.name} title={title} description={t("tasks.description")} />
      {done && DONE.has(done) ? (
        <RecordedArrival message={t("tasks.done", { done })} param="done" />
      ) : null}
      <TabNav
        label={t("tasks.views")}
        linkComponent={Link}
        items={[
          {
            href: tasksHref(query, { view: "mine" }),
            label: t("tasks.view.mine"),
            current: query.view === "mine",
          },
          {
            href: tasksHref(query, { view: "team" }),
            label: t("tasks.view.team"),
            current: query.view === "team",
          },
        ]}
      />
      <nav aria-label={t("tasks.filters")} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <FilterLink href={tasksHref(query, { status: "open" })} current={query.status === "open"}>
            {t("tasks.filter.open")}
          </FilterLink>
          <FilterLink
            href={tasksHref(query, { status: "closed" })}
            current={query.status === "closed"}
          >
            {t("tasks.filter.closed")}
          </FilterLink>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FilterLink href={tasksHref(query, { range: "day" })} current={query.range === "day"}>
            {t("tasks.filter.day")}
          </FilterLink>
          <FilterLink href={tasksHref(query, { range: "week" })} current={query.range === "week"}>
            {t("tasks.filter.week")}
          </FilterLink>
          <ButtonLink href={tasksHref(query, { reviews: !query.reviews })} variant="secondary">
            {t("tasks.filter.reviews", { on: query.reviews ? "yes" : "no" })}
          </ButtonLink>
        </div>
      </nav>
      {mayManage ? (
        <Card as="section" title={t("tasks.new.heading")} headingLevel={2}>
          <NewTaskForm
            selfId={me.tenantUserId}
            returnTo={here}
            locations={me.locations.map((l) => ({ id: l.id, name: l.name }))}
            locationId={locationId}
          />
        </Card>
      ) : null}
      <Card
        as="section"
        id="task-list"
        title={t("tasks.list.title", { view: query.view, status: query.status })}
        headingLevel={2}
      >
        <p className="m-0 mb-3 text-body-dense" aria-live="polite">
          {t("tasks.list.count", { count: windowItems.length })}{" "}
          {t("tasks.list.readAt", { dateTime: readAt })}
        </p>
        {listed.data.truncated ? (
          <p role="note" className="m-0 mb-3 font-semibold">
            {t("tasks.list.truncated")}
          </p>
        ) : null}
        {windowItems.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<ListChecks size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("tasks.list.empty", { reviews: query.reviews ? "yes" : "no" })}
          />
        ) : (
          <TaskPage
            items={windowItems}
            shown={show}
            moreHref={moreHref("show", show)}
            render={renderTask}
          />
        )}
      </Card>
      {query.status === "open" && (earlierItems.length > 0 || earlierOmitted > 0) ? (
        <Card as="section" id="task-list-earlier" title={t("tasks.earlier.title")} headingLevel={2}>
          <p className="m-0 mb-3 text-body-dense">
            {t("tasks.earlier.about", { count: earlierItems.length })}
          </p>
          {earlierOmitted > 0 ? (
            <p role="note" className="m-0 mb-3 font-semibold">
              {t("tasks.earlier.omitted", { count: earlierOmitted })}
            </p>
          ) : null}
          <TaskPage
            items={earlierItems}
            shown={showEarlier}
            moreHref={moreHref("showEarlier", showEarlier)}
            render={renderTask}
          />
        </Card>
      ) : null}
    </div>
  );
}
