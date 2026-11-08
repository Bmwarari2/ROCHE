import { Card, EmptyState, PageHeader, StatusChip } from "@harbour/ui";
import { Pill, TriangleAlert, Zap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Notice } from "@/components/care/Notice";
import {
  ClockChange,
  DoseNotices,
  EntryStatusNotice,
  PrnFigures,
} from "@/components/medicines/RoundDetails";
import { PersonHeaderCompact } from "@/components/people/PersonHeader";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { conflictsHref } from "@/lib/administration-corrections";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  defaultSlot,
  doseChip,
  locationRoundHref,
  medicinesRoundShown,
  personRoundHref,
  roundPeople,
} from "@/lib/medicine-round";
import { personNames } from "@/lib/people";

type Params = Promise<{ locationId: string }>;

export const metadata: Metadata = { title: t("medicines.round.title") };

const iconProps = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * The medicines round for a location (slice 53; MEDS-002, MEDS-003; medicines.md section 16): each
 * person living there whom the reader may see, by room, with their doses from two hours ago to two
 * hours ahead (any earlier dose still late or due included by the API), late first and
 * time-critical first within each state, each with its state as an icon and a word; and their
 * when-required medicines with when last given and when the next may be given. Each person links
 * to their round, where doses are recorded with their allergies beside the medicine (HZ-007).
 */
export default async function MedicinesRoundPage({ params }: { readonly params: Params }) {
  const { locationId } = await params;
  if (!isUuid(locationId)) notFound();
  const { me } = await getShellContext();
  const title = t("medicines.round.title");
  if (!medicinesRoundShown(me.permissions)) return <SafetyForbidden title={title} />;
  const location = me.locations.find((l) => l.id === locationId);
  if (!location) notFound();
  const slot = defaultSlot();
  const api = await tenantApi();
  const [read, people] = await Promise.all([
    api.GET("/v1/locations/{id}/medicine-round", {
      params: { path: { id: locationId }, query: slot },
    }),
    api.GET("/v1/people", { params: { query: { locationId } } }),
  ]);
  if (problemCode(read.error) === "not_found") notFound();
  if (problemCode(read.error) === "missing_permission") return <SafetyForbidden title={title} />;
  if (!read.data) failWith(read.error, read.response, locationRoundHref(locationId));
  const rows = roundPeople(read.data.people, people.data?.items ?? []);
  const when = (iso: string) => formatDateTime(iso) ?? "";

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <PageHeader
        eyebrow={location.name}
        title={title}
        description={t("medicines.round.slot", { from: when(slot.from), to: when(slot.to) })}
      />
      <p className="m-0">
        <Link
          href={conflictsHref(locationId)}
          className="inline-flex min-h-target items-center underline"
        >
          {t("medicines.conflicts.link")}
        </Link>
      </p>
      {people.error ? (
        <Notice
          tone="warning"
          icon={<TriangleAlert {...iconProps} />}
          title={t("medicines.round.peopleUnreadable")}
        />
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          icon={<Pill {...iconProps} />}
          title={t("medicines.round.nobody")}
          description={t("medicines.round.nobodyAbout")}
        />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {rows.map(({ entry, person }) => (
            <li key={entry.personId}>
              <Card as="article" title={person ? undefined : t("medicines.round.someone")}>
                <div className="flex flex-col gap-3">
                  {person ? <PersonHeaderCompact person={person} headingLevel={2} /> : null}
                  {entry.unavailable ? (
                    <Notice
                      tone="warning"
                      icon={<TriangleAlert {...iconProps} />}
                      title={entry.unavailable}
                    />
                  ) : null}
                  {/* Without the person's name, photo and allergies, no dose is listed (HZ-001). */}
                  {person && entry.doses.length > 0 ? (
                    <div className="flex flex-col gap-1">
                      <h3 className="m-0 text-body font-semibold">{t("medicines.round.doses")}</h3>
                      <ul className="m-0 flex list-none flex-col gap-2 p-0">
                        {entry.doses.map((dose) => {
                          const chip = doseChip(dose.state, dose.stateInWords);
                          return (
                            <li
                              key={`${dose.entryId}-${dose.dueAt}`}
                              className="flex flex-col gap-1 border-b border-border py-2"
                            >
                              <p className="m-0 flex flex-wrap items-center gap-2">
                                <StatusChip
                                  status={chip.status}
                                  label={chip.label}
                                  icon={chip.icon}
                                />
                                <span className="font-semibold">{dose.productName}</span>
                                <span>{dose.doseInWords}</span>
                                <span>{t("medicines.round.dueAt", { at: when(dose.dueAt) })}</span>
                                {dose.timeCritical ? (
                                  <span className="inline-flex items-center gap-1 font-semibold">
                                    <Zap size={16} strokeWidth={1.5} aria-hidden="true" />
                                    {t("medicines.round.timeCritical")}
                                  </span>
                                ) : null}
                              </p>
                              <ClockChange dose={dose} />
                              <EntryStatusNotice status={dose.entryStatus} />
                              <DoseNotices notices={dose.notices} />
                              {dose.reviewInWords ? (
                                <p className="m-0">{dose.reviewInWords}</p>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}
                  {person && entry.whenRequired.length > 0 ? (
                    <div className="flex flex-col gap-1">
                      <h3 className="m-0 text-body font-semibold">{t("medicines.round.prn")}</h3>
                      <ul className="m-0 flex list-none flex-col gap-2 p-0">
                        {entry.whenRequired.map((prn) => (
                          <li key={prn.entryId} className="flex flex-col gap-1">
                            <p className="m-0 font-semibold">{prn.productName}</p>
                            <PrnFigures prn={prn} unit={null} />
                            <DoseNotices notices={prn.notices} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {person &&
                  entry.doses.length === 0 &&
                  entry.whenRequired.length === 0 &&
                  !entry.unavailable ? (
                    <p className="m-0">{t("medicines.round.nothingInSlot")}</p>
                  ) : null}
                  <p className="m-0">
                    <Link
                      href={personRoundHref(entry.personId)}
                      className="inline-flex min-h-target items-center underline"
                    >
                      {person
                        ? t("medicines.round.openPerson", {
                            name: personNames(person).full,
                          })
                        : t("medicines.round.openSomeone")}
                    </Link>
                  </p>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
