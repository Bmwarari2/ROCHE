import { Card, EmptyState, PageHeader } from "@harbour/ui";
import { CircleCheck, ShieldAlert, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Notice } from "@/components/care/Notice";
import { ConflictRecords } from "@/components/medicines/ConflictRecords";
import { PersonHeaderCompact } from "@/components/people/PersonHeader";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { conflictHref, entryUnit } from "@/lib/administration-corrections";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { locationRoundHref, medicinesRoundShown } from "@/lib/medicine-round";
import { personNames } from "@/lib/people";
import { firstParam } from "@/lib/record-metadata";

type Params = Promise<{ locationId: string }>;

export const metadata: Metadata = { title: t("medicines.conflicts.title") };

const iconProps = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * Doses recorded twice at a home (HZ-004; medicines.md 15.4): each dose two phones recorded, both
 * records in words and whether they agree, oldest first, for the nurse in charge to decide on the
 * dose's own page. A controlled drug's is decided here, never on a phone.
 */
export default async function ConflictsPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locationId } = await params;
  const done = firstParam((await searchParams).done);
  if (!isUuid(locationId)) notFound();
  const { me } = await getShellContext();
  const title = t("medicines.conflicts.title");
  if (!medicinesRoundShown(me.permissions)) return <SafetyForbidden title={title} />;
  const location = me.locations.find((l) => l.id === locationId);
  if (!location) notFound();
  const api = await tenantApi();
  const [read, people] = await Promise.all([
    api.GET("/v1/medicine-administration-conflicts", { params: { query: { locationId } } }),
    api.GET("/v1/people", { params: { query: { locationId } } }),
  ]);
  if (problemCode(read.error) === "missing_permission") return <SafetyForbidden title={title} />;
  if (!read.data) failWith(read.error, read.response, locationRoundHref(locationId));
  const conflicts = read.data.conflicts;
  const personIds = [...new Set(conflicts.map((c) => c.personId))];
  const records = await Promise.all(
    personIds.map((id) => api.GET("/v1/people/{id}/medicines", { params: { path: { id } } })),
  );
  const entries = new Map(
    records.flatMap((r) => r.data?.entries ?? []).map((e) => [e.id, e] as const),
  );
  const byId = new Map((people.data?.items ?? []).map((p) => [p.id, p] as const));

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      {done === "resolved" ? (
        <RecordedArrival message={t("medicines.conflicts.resolvedArrival")} param="done" />
      ) : null}
      <PageHeader
        eyebrow={location.name}
        title={title}
        description={t("medicines.conflicts.intro")}
      />
      {read.data.truncated ? (
        <Notice
          tone="warning"
          icon={<TriangleAlert {...iconProps} />}
          title={t("medicines.conflicts.truncated")}
        />
      ) : null}
      {conflicts.length === 0 ? (
        <EmptyState
          icon={<CircleCheck {...iconProps} />}
          title={t("medicines.conflicts.none")}
          description={t("medicines.conflicts.noneAbout")}
        />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {conflicts.map((c) => {
            const person = byId.get(c.personId);
            const entry = entries.get(c.entryId);
            const medicine = entry?.product.name ?? t("medicines.conflicts.someMedicine");
            return (
              <li key={c.id}>
                <Card
                  as="article"
                  title={t("medicines.conflicts.cardTitle", { medicine })}
                  headingLevel={2}
                >
                  <div className="flex flex-col gap-3">
                    {person ? (
                      <PersonHeaderCompact person={person} headingLevel={3} />
                    ) : (
                      <p className="m-0">{t("medicines.conflicts.personHidden")}</p>
                    )}
                    <p className="m-0">
                      {t("medicines.conflicts.due", { at: formatDateTime(c.dueAt) ?? "" })}
                    </p>
                    {c.controlledDrug ? (
                      <p className="m-0 flex items-center gap-2 font-semibold">
                        <ShieldAlert size={18} strokeWidth={1.5} aria-hidden="true" />
                        {t("medicines.conflicts.controlled")}
                      </p>
                    ) : null}
                    <ConflictRecords
                      conflict={c}
                      unit={entry ? (entryUnit(entry)?.name ?? null) : null}
                    />
                    <p className="m-0">
                      <Link
                        href={conflictHref(locationId, c.id)}
                        className="inline-flex min-h-target items-center underline"
                      >
                        {t("medicines.conflicts.open", {
                          medicine,
                          person: person
                            ? personNames(person).full
                            : t("medicines.conflicts.someone"),
                          at: formatDateTime(c.dueAt) ?? "",
                        })}
                      </Link>
                    </p>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      <p className="m-0">
        <Link
          href={locationRoundHref(locationId)}
          className="inline-flex min-h-target items-center underline"
        >
          {t("medicines.conflicts.backToRound")}
        </Link>
      </p>
    </div>
  );
}
