import type { HandoverNoteItem, PersonSummary } from "@harbour/contracts";
import { Card, EmptyState, PageHeader, StatusChip } from "@harbour/ui";
import { ClipboardCheck, Lock, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrivalNotice } from "@/components/care/ArrivalNotice";
import {
  AcknowledgeHandover,
  CompileHandover,
  HandoverNoteForm,
} from "@/components/care/HandoverActions";
import { Notice } from "@/components/care/Notice";
import { CommunicationStatus } from "@/components/people/CommunicationStatus";
import { SafetyChip, SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import {
  groupHandover,
  handoverChips,
  handoverShown,
  itemKindChip,
  itemSourceHref,
  shiftTitle,
  youChip,
} from "@/lib/handover";
import { t } from "@/lib/i18n";
import { staffName } from "@/lib/mca";
import { communicationSummary, personNames } from "@/lib/people";
import { firstParam } from "@/lib/record-metadata";

type Params = Promise<{ locationId: string; handoverId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("care.handover.pageTitle") };

const iconProps = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;
const DONE = new Set(["compiled", "acknowledged"]);

function Notes({ notes }: { readonly notes: readonly HandoverNoteItem[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {notes.map((note) => (
        <li key={note.id} className="border-s-4 border-border ps-3">
          <p className="m-0 whitespace-pre-line break-words">{note.body}</p>
          <p className="m-0 text-body-dense text-text-secondary">
            {t("care.handover.noteBy", {
              who: note.createdByStaff
                ? staffName(note.createdByStaff, t)
                : t("care.handover.someone"),
              dateTime: formatDateTime(note.createdAt) ?? "",
            })}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** A person's name with their communication needs beside it, labelled in every state (AIS). */
function PersonLine({ person }: { readonly person: PersonSummary }) {
  return (
    <div className="flex flex-col gap-1">
      <Link
        href={`/people/${person.id}`}
        className="inline-flex min-h-target items-center font-semibold underline"
      >
        {personNames(person).full}
        {person.roomLabel ? `, ${t("care.handover.room", { room: person.roomLabel })}` : ""}
      </Link>
      <dl className="m-0 flex flex-wrap items-start gap-x-2 gap-y-1">
        <dt className="text-body-dense font-semibold">{t("people.header.communicationNeeds")}</dt>
        <dd className="m-0">
          <CommunicationStatus
            summary={communicationSummary(person, t)}
            flagLabel={t("people.header.communicationNeeds")}
            compact
          />
        </dd>
      </dl>
    </div>
  );
}

/**
 * One shift handover (care.md rule 14; COMMS-006; hazards HZ-001, HZ-008, HZ-011): its items by
 * person, most urgent first, each a reference to its record with a link, the notes on each and on
 * the whole handover, and who has acknowledged it. The incoming shift acknowledges it as shown;
 * items added since are marked new. A reader who may see only some people is told so.
 */
export default async function HandoverPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { locationId, handoverId } = await params;
  if (!isUuid(locationId) || !isUuid(handoverId)) notFound();
  const { me } = await getShellContext();
  const listTitle = t("care.handover.title");
  if (!handoverShown(me.permissions)) return <SafetyForbidden title={listTitle} />;
  const done = firstParam((await searchParams).done);
  const api = await tenantApi();
  const read = await api.GET("/v1/locations/{id}/handovers/{handoverId}", {
    params: { path: { id: locationId, handoverId } },
  });
  if (problemCode(read.error) === "not_found") notFound();
  if (problemCode(read.error) === "missing_permission") {
    return <SafetyForbidden title={listTitle} />;
  }
  if (!read.data) failWith(read.error, read.response, `/handover/${locationId}/${handoverId}`);
  const handover = read.data;
  const title = shiftTitle(handover, t);
  const people = new Map(handover.people.map((p) => [p.id, p]));
  const unseen = new Set(handover.you.unseenKeys);
  const { groups, generalNotes } = groupHandover(handover);
  const location = me.locations.find((l) => l.id === locationId);
  const staff = new Map(
    handover.staff.flatMap((s) => (s ? [[s.id, staffName(s, t)] as const] : [])),
  );

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
        <Link
          href={`/handover/${locationId}`}
          className="inline-flex min-h-target items-center underline"
        >
          {listTitle}
        </Link>
        <span aria-hidden="true" className="px-2 text-text-secondary">
          ›
        </span>
        <span aria-current="page">{title}</span>
      </nav>
      <PageHeader eyebrow={location?.name ?? me.tenant.name} title={title} />
      {done && DONE.has(done) ? (
        <ArrivalNotice>{t("care.handover.arrived", { done })}</ArrivalNotice>
      ) : null}
      <p className="m-0 flex flex-wrap items-center gap-2">
        {handoverChips(handover, t).map((chip) => (
          <SafetyChip key={chip.label} chip={chip} />
        ))}
        <SafetyChip chip={youChip(handover.you, t)} />
      </p>
      <p className="m-0 text-body-dense text-text-secondary">
        {t("care.handover.compiledAt", {
          compiled: formatDateTime(handover.compiledAt) ?? "",
          refreshed: formatDateTime(handover.refreshedAt) ?? "",
        })}
      </p>
      {handover.limitedToYourPeople ? (
        <Notice icon={<Lock {...iconProps} />} title={t("care.handover.limited")} />
      ) : null}
      {handover.open ? (
        <CompileHandover locationId={locationId} label={t("care.handover.refresh")} />
      ) : null}

      <Card as="section" title={t("care.handover.itemsTitle")} headingLevel={2}>
        {groups.length === 0 ? (
          <EmptyState
            headingLevel={3}
            icon={<ClipboardCheck size={32} strokeWidth={1.5} aria-hidden="true" />}
            title={t("care.handover.noItems")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {groups.map((group) => {
              const person = group.personId ? people.get(group.personId) : undefined;
              return (
                <li key={group.personId ?? "none"} className="flex flex-col gap-3">
                  {person ? (
                    <PersonLine person={person} />
                  ) : (
                    <p className="m-0 font-semibold">
                      {t("care.handover.noPerson", { hidden: String(group.personId !== null) })}
                    </p>
                  )}
                  <ul className="m-0 flex list-none flex-col gap-3 p-0">
                    {group.items.map(({ item, notes }) => {
                      const href = itemSourceHref(item);
                      const chip = itemKindChip(item.kind, t);
                      return (
                        <li
                          key={item.key}
                          className="flex flex-col gap-2 rounded-input border border-border p-3"
                          data-handover-item={item.kind}
                        >
                          <p className="m-0 flex flex-wrap items-center gap-2">
                            <SafetyChip chip={chip} />
                            {item.lateAddition ? (
                              <StatusChip
                                status="info"
                                label={t("care.handover.lateAddition")}
                                icon={Sparkles}
                              />
                            ) : null}
                            {unseen.has(item.key) ? (
                              <StatusChip status="due" label={t("care.handover.new")} />
                            ) : null}
                          </p>
                          <p className="m-0 text-body-dense">
                            {t("care.handover.at", { dateTime: formatDateTime(item.at) ?? "" })}
                          </p>
                          {href ? (
                            <Link
                              href={href}
                              className="inline-flex min-h-target items-center underline"
                            >
                              {t("care.handover.open", { source: item.sourceType })}
                            </Link>
                          ) : null}
                          <Notes notes={notes} />
                          {handover.open ? (
                            <HandoverNoteForm
                              locationId={locationId}
                              handoverId={handoverId}
                              itemKey={item.key}
                              open={t("care.handover.addItemNote", { kind: chip.label })}
                            />
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card as="section" title={t("care.handover.generalTitle")} headingLevel={2}>
        <div className="flex flex-col gap-3">
          {generalNotes.length === 0 ? (
            <p className="m-0">{t("care.handover.noGeneralNotes")}</p>
          ) : (
            <Notes notes={generalNotes} />
          )}
          {handover.open ? (
            <HandoverNoteForm
              locationId={locationId}
              handoverId={handoverId}
              itemKey={null}
              open={t("care.handover.addNote")}
            />
          ) : (
            <p className="m-0 text-body-dense text-text-secondary">{t("care.handover.closed")}</p>
          )}
        </div>
      </Card>

      <Card as="section" title={t("care.handover.acknowledgedTitle")} headingLevel={2}>
        <div className="flex flex-col gap-3">
          {handover.acknowledgements.length === 0 ? (
            <p className="m-0">{t("care.handover.noneAcknowledged")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {handover.acknowledgements.map((a) => (
                <li key={a.id}>
                  {t("care.handover.acknowledgedBy", {
                    who: a.staff ? staffName(a.staff, t) : t("care.handover.someone"),
                    dateTime: formatDateTime(a.acknowledgedAt) ?? "",
                  })}
                </li>
              ))}
            </ul>
          )}
          {handover.pending.length > 0 ? (
            <p className="m-0 text-body-dense">
              {t("care.handover.pending", {
                names: handover.pending
                  .map((id) => staff.get(id) ?? t("care.handover.someone"))
                  .join(", "),
              })}
            </p>
          ) : null}
          {!handover.you.acknowledged || handover.you.unseenKeys.length > 0 ? (
            <AcknowledgeHandover
              locationId={locationId}
              handoverId={handoverId}
              seenToken={handover.you.seenToken}
            />
          ) : null}
        </div>
      </Card>
    </div>
  );
}
