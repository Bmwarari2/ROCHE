import { Card, PageHeader } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ReadOnlyNotice } from "@/components/care/ReadOnlyNotice";
import { IncidentForm } from "@/components/safety/IncidentForm";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext } from "@/lib/api";
import { can, writeAccess } from "@/lib/care-record";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { personNames } from "@/lib/people";
import { getPerson } from "@/lib/person-record";

/** The page title says what the page is for, never who the incident is about. */
export const metadata: Metadata = { title: t("safety.record.title") };

type SearchParams = Promise<{ person?: string | string[] }>;

/**
 * Record an incident or near miss (register row SAFE-001; hazards HZ-013 and HZ-027). Opened
 * from a person's record (`?person=`), it is about them at their home, and offered only when the
 * API lists `safety.incident.report` among the permissions reaching them (ADR-0071); otherwise
 * the reporter chooses one of the locations they work at, and the API refuses one their role
 * does not reach there (the API gives no per-permission list of locations; STATUS item 19).
 */
export default async function NewIncidentPage({
  searchParams,
}: {
  readonly searchParams: SearchParams;
}) {
  const { me, locationId } = await getShellContext();
  const title = t("safety.record.title");
  if (!can(me.permissions, "safety.incident.report")) return <SafetyForbidden title={title} />;
  const { person: param } = await searchParams;
  let about: { readonly id: string; readonly name: string; readonly locationId: string } | null =
    null;
  let readOnly = false;
  if (param !== undefined) {
    if (typeof param !== "string" || !isUuid(param)) notFound();
    const { person } = await getPerson(param);
    if (!person) notFound();
    about = { id: person.id, name: personNames(person).preferred, locationId: person.locationId };
    readOnly = !writeAccess(person, me.permissions, "safety.incident.report").canWrite;
  }
  const locations = about
    ? [
        {
          id: about.locationId,
          name:
            me.locations.find((l) => l.id === about.locationId)?.name ??
            t("safety.incident.locationHidden"),
        },
      ]
    : me.locations.map((l) => ({ id: l.id, name: l.name }));
  const eyebrow =
    locations.length === 1
      ? locations[0]?.name
      : (me.locations.find((l) => l.id === locationId)?.name ?? me.tenant.name);
  const listTitle = t("safety.incidents.title");

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      {can(me.permissions, "safety.incident.read") ? (
        <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
          <Link href="/incidents" className="inline-flex min-h-target items-center underline">
            {listTitle}
          </Link>
          <span aria-hidden="true" className="px-2 text-text-secondary">
            ›
          </span>
          <span>{title}</span>
        </nav>
      ) : null}
      <PageHeader eyebrow={eyebrow} title={title} description={t("safety.record.description")} />
      <Card>
        {readOnly ? (
          <ReadOnlyNotice text={t("safety.record.notForPerson")} />
        ) : locations.length === 0 ? (
          <p className="m-0 max-w-prose">{t("safety.record.noLocations")}</p>
        ) : (
          <IncidentForm
            locations={locations}
            defaultLocationId={locationId ?? null}
            person={about ? { id: about.id, name: about.name } : null}
          />
        )}
      </Card>
    </div>
  );
}
