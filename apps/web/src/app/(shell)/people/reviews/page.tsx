import { EmptyState, PageHeader } from "@harbour/ui";
import { Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ReviewChip } from "@/components/people/ReviewChip";
import { ReviewTracker, type TrackerTableRow } from "@/components/people/ReviewTracker";
import { WarningLine } from "@/components/people/WarningLine";
import { getShellContext, tenantApi } from "@/lib/api";
import { can } from "@/lib/care-record";
import { formatDate } from "@/lib/format";
import { peopleLabel, t } from "@/lib/i18n";
import { type CommunicationSummary, communicationSummary, personNames } from "@/lib/people";
import { trackerRows } from "@/lib/reviews";

export async function generateMetadata(): Promise<Metadata> {
  const { me } = await getShellContext();
  return {
    title: t("care.title.tab", {
      tab: t("people.reviews.tracker.title"),
      people: peopleLabel(me.tenant.terminology),
    }),
  };
}

/**
 * The manager's tracker (people.md section 6a; PEOP-008; HZ-008): reviews due and overdue at the
 * chosen location, or at every location the viewer works at, soonest and overdue first. The dates
 * and states are the API's; names come from the viewer's own people list, so nobody outside their
 * scope is named.
 */
export default async function ReviewsDuePage() {
  const { me, locationId } = await getShellContext();
  const title = t("people.reviews.tracker.title");
  const people = peopleLabel(me.tenant.terminology);
  const breadcrumb = (
    <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
      <Link href="/people" className="underline">
        {people}
      </Link>
      <span aria-hidden="true" className="px-2 text-text-secondary">
        ›
      </span>
      <span>{title}</span>
    </nav>
  );
  if (!can(me.permissions, "care.plan.read")) {
    return (
      <div className="mx-auto flex w-full max-w-content flex-col gap-8">
        {breadcrumb}
        <PageHeader title={title} />
        <EmptyState
          icon={<Lock size={32} strokeWidth={1.5} aria-hidden="true" />}
          title={t("errors.forbidden")}
        />
      </div>
    );
  }
  const api = await tenantApi();
  const locations = locationId ? me.locations.filter((l) => l.id === locationId) : me.locations;
  const [list, ...results] = await Promise.all([
    api.GET("/v1/people", { params: { query: locationId ? { locationId } : {} } }),
    ...locations.map((location) =>
      api
        .GET("/v1/locations/{id}/reviews", { params: { path: { id: location.id } } })
        .then((r) => ({ location, data: r.data ?? null })),
    ),
  ]);
  const communication = new Map<string, CommunicationSummary>(
    (list.data?.items ?? []).map((person) => [person.id, communicationSummary(person, t)]),
  );
  const names = new Map(
    (list.data?.items ?? []).map((person) => {
      const n = personNames(person);
      return [person.id, n.hasPreferred ? `${n.full} (${n.preferred})` : n.full] as const;
    }),
  );
  const locationNames = new Map(me.locations.map((l) => [l.id, l.name]));
  const unreadable = results.filter((r) => r.data === null).map((r) => r.location.name);
  const due = results.flatMap((r) =>
    (r.data?.items ?? []).map((item) => ({ ...item, locationId: r.location.id })),
  );
  const named = trackerRows(due, names, locationNames);
  // Reviews for people the viewer's list does not name are counted, never dropped in silence.
  const leftOut = list.data ? due.length - named.length : 0;
  const rows: TrackerTableRow[] = named.map((row) => ({
    id: `${row.personId}-${row.kind}-${row.dueOn}`,
    personId: row.personId,
    name: row.name,
    review: t("people.reviews.kind", { kind: row.kind }),
    dueOn: row.dueOn,
    dueLabel: formatDate(row.dueOn) ?? row.dueOn,
    location: row.locationName,
    chip: <ReviewChip state={row.state} />,
    communication: communication.get(row.personId) ?? {
      kind: "not_recorded",
      label: t("common.notRecorded"),
    },
  }));
  const location = me.locations.find((l) => l.id === locationId);

  return (
    <div className="flex w-full flex-col gap-6">
      {breadcrumb}
      <PageHeader
        eyebrow={location ? location.name : me.tenant.name}
        title={title}
        description={t("people.reviews.tracker.intro")}
      />
      {unreadable.map((name) => (
        <WarningLine key={name} alert>
          {t("people.reviews.tracker.unavailable", { location: name })}
        </WarningLine>
      ))}
      {leftOut > 0 ? (
        <WarningLine data-reviews-left-out="">
          {t("people.reviews.tracker.leftOut", { count: leftOut })}
        </WarningLine>
      ) : null}
      {list.data && unreadable.length === 0 ? null : (
        <a
          href="/people/reviews"
          className="inline-flex min-h-target items-center self-start underline"
        >
          {t("common.retry")}
        </a>
      )}
      {/* Never the all-clear when the names could not be read (HZ-008). */}
      {!list.data ? (
        <WarningLine alert>{t("people.reviews.tracker.listUnavailable")}</WarningLine>
      ) : (
        <ReviewTracker
          rows={rows}
          showLocation={locations.length > 1}
          labels={{
            caption: t("people.reviews.tracker.caption"),
            person: t("people.reviews.tracker.person"),
            review: t("people.reviews.tracker.review"),
            due: t("people.reviews.tracker.due"),
            state: t("people.reviews.tracker.state"),
            location: t("people.reviews.tracker.location"),
            communication: t("people.header.communicationNeeds"),
            empty: t("people.reviews.tracker.none"),
          }}
        />
      )}
    </div>
  );
}
