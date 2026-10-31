import { ButtonLink, Card, StatusChip } from "@harbour/ui";
import { History, ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import { NoAccess } from "@/components/care/NoAccess";
import { Notice } from "@/components/care/Notice";
import { ReadOnlyNotice } from "@/components/care/ReadOnlyNotice";
import { RecordFrame } from "@/components/care/RecordFrame";
import { TemplateArrival } from "@/components/comms/TemplateArrival";
import { AdmitForm } from "@/components/people/admission/AdmitForm";
import { BedMoveForm, ChecklistItemActions } from "@/components/people/admission/RoomForms";
import { PersonStatusChip, SafetyCriticalChip } from "@/components/people/admission/StatusChips";
import {
  ADMISSION_MANAGE,
  admissionReadiness,
  CHECKLIST_WRITERS,
  checklistChip,
  checklistItems,
  checklistProgress,
  freeBeds,
  mayMoveRoom,
  mayTickChecklist,
  moveHistoryView,
  whoDid,
} from "@/lib/admission";
import { getShellContext, tenantApi } from "@/lib/api";
import { can, tabHref, writeAccess } from "@/lib/care-record";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { getPerson, readOrFail } from "@/lib/person-record";
import { firstParam, recordMetadata } from "@/lib/record-metadata";
import { ukToday } from "@/lib/uk-time";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The page title names the tab, never the person. */
export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("admission");
}

/**
 * The admission and room tab (people.md rules 5 and 6; PEOP-007): admitting a person whose
 * decision is positive and whose conditions are met, the placement, the room and bed now with
 * every move before it (the header's room comes from this history, HZ-001), a move to another
 * room, and the welcome checklist, safety-critical items first. Admission and moves need
 * people.admission.manage; the checklist is ticked by managers and nurses.
 */
async function AdmissionTab({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await params;
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!can(me.permissions, "people.person.read")) return <NoAccess />;
  const api = await tenantApi();
  const path = tabHref(id, "admission");
  const status = person.status;
  const manage = writeAccess(person, me.permissions, ADMISSION_MANAGE);
  const checklistWriters = CHECKLIST_WRITERS.map((p) => writeAccess(person, me.permissions, p));
  const tickChecklist = checklistWriters.some((w) => w.canWrite);
  const atPreAdmission = status === "pre_admission";
  const wantsBeds = manage.canWrite && (atPreAdmission || mayMoveRoom(status));
  const today = ukToday();
  const [admission, history, services, board, assessment] = await Promise.all([
    api
      .GET("/v1/people/{id}/admission", { params: { path: { id } } })
      .then((r) => readOrFail(r, path)),
    api
      .GET("/v1/people/{id}/bed-moves", { params: { path: { id } } })
      .then((r) => readOrFail(r, path)),
    api
      .GET("/v1/locations/{id}/services", { params: { path: { id: person.locationId } } })
      .then((r) => r.data ?? null),
    wantsBeds
      ? api
          .GET("/v1/locations/{id}/beds", {
            params: { path: { id: person.locationId }, query: { date: today } },
          })
          .then((r) => r.data ?? null)
      : null,
    atPreAdmission
      ? api
          .GET("/v1/people/{id}/pre-admission", { params: { path: { id } } })
          .then((r) => r.data ?? null)
      : null,
  ]);
  if (!admission || !history) return <NoAccess />;
  const query = await searchParams;
  const done = firstParam(query.done);
  const readiness = admissionReadiness(admission.decision);
  const beds = board ? freeBeds(board, id) : [];
  const serviceName = (serviceId: string) =>
    services?.items.find((s) => s.id === serviceId)?.name ?? t("people.admission.serviceUnknown");
  const placement = admission.placement;
  const checklist = admission.welcomeChecklist;
  const progress = checklistProgress(checklist);
  const moves = moveHistoryView(history.items.flatMap((item) => (item ? [item] : [])));
  const current = moves.find((m) => m.current) ?? null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 text-eyebrow">{t("people.admission.title")}</h2>
        <PersonStatusChip status={status} />
      </div>
      {done === "admitted" ? <TemplateArrival message={t("people.admission.arrived")} /> : null}

      {atPreAdmission || status === "enquiry" || status === "not_admitted" ? (
        <Card as="section" title={t("people.admission.admit.title")} headingLevel={3}>
          <div className="flex flex-col gap-4">
            {status !== "pre_admission" ? (
              <p className="m-0">{t("people.admission.admit.notAtPreAdmission", { status })}</p>
            ) : !readiness.ready ? (
              <div className="flex flex-col gap-2">
                <p className="m-0">
                  {t("people.admission.admit.notReady", { reason: readiness.reason })}
                </p>
                {admission.conditionsOutstanding.length > 0 ? (
                  <ul className="m-0 flex flex-col gap-1 ps-5">
                    {admission.conditionsOutstanding.map((condition) => (
                      <li key={condition}>{condition}</li>
                    ))}
                  </ul>
                ) : null}
                <div>
                  <ButtonLink href={tabHref(id, "pre-admission")} variant="secondary">
                    {t("people.admission.admit.toPreAdmission")}
                  </ButtonLink>
                </div>
              </div>
            ) : manage.canWrite ? (
              services && services.items.length > 0 ? (
                <AdmitForm
                  personId={id}
                  version={person.version}
                  services={services.items.map((s) => ({ id: s.id, name: s.name }))}
                  defaultServiceId={assessment?.assessment?.serviceId ?? null}
                  defaultType={assessment?.assessment?.placementTypeSought ?? null}
                  defaultTrialEndsOn={admission.decision?.trialEndsOn ?? null}
                  beds={beds}
                  today={today}
                />
              ) : (
                <p className="m-0">{t("people.preAdmission.start.noServices")}</p>
              )
            ) : (
              <>
                <p className="m-0">{t("people.admission.admit.ready")}</p>
                {manage.readOnlyNotice ? <ReadOnlyNotice text={t(manage.readOnlyNotice)} /> : null}
              </>
            )}
          </div>
        </Card>
      ) : null}

      {placement ? (
        <Card as="section" title={t("people.admission.placement.title")} headingLevel={3}>
          <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-[max-content_1fr]">
            <dt className="font-semibold">{t("people.admission.placement.service")}</dt>
            <dd className="m-0">{serviceName(placement.serviceId)}</dd>
            <dt className="font-semibold">{t("people.admission.placement.type")}</dt>
            <dd className="m-0">{t("people.placementType", { type: placement.type })}</dd>
            <dt className="font-semibold">{t("people.admission.placement.start")}</dt>
            <dd className="m-0">{formatDate(placement.startDate)}</dd>
            {placement.trialEndsOn ? (
              <>
                <dt className="font-semibold">{t("people.admission.placement.trialEnds")}</dt>
                <dd className="m-0">{formatDate(placement.trialEndsOn)}</dd>
              </>
            ) : null}
            <dt className="font-semibold">{t("people.admission.placement.funding")}</dt>
            <dd className="m-0">
              {t("people.admission.placement.fundingValue", {
                council: placement.localAuthorityFunded ? "yes" : "no",
                nhs: placement.nhsFunded ? "yes" : "no",
              })}
            </dd>
          </dl>
        </Card>
      ) : null}

      <Card as="section" title={t("people.room.title")} headingLevel={3}>
        <div className="flex flex-col gap-4">
          <p className="m-0 text-intro font-semibold" data-current-room="">
            {history.roomLabel
              ? t("people.room.current", {
                  room: history.roomLabel,
                  since: formatDate(current?.item.from) ?? "",
                })
              : t("people.room.none")}
          </p>
          {manage.canWrite && mayMoveRoom(status) && current ? (
            <BedMoveForm personId={id} version={person.version} beds={beds} today={today} />
          ) : null}
          <section aria-labelledby="room-history" className="flex flex-col gap-2">
            <h4 id="room-history" className="m-0 text-body font-semibold">
              {t("people.room.history")}
            </h4>
            {moves.length === 0 ? (
              <p className="m-0">{t("people.room.historyNone")}</p>
            ) : (
              <ol className="m-0 flex list-none flex-col p-0">
                {moves.map(({ item, current: now }) => (
                  <li
                    key={item.id}
                    className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">
                        {t("people.room.roomAndBed", { room: item.roomLabel, bed: item.bed })}
                      </span>
                      {now ? (
                        <StatusChip status="info" label={t("people.room.currentChip")} />
                      ) : null}
                      {item.backdated ? (
                        <StatusChip
                          status="due"
                          icon={History}
                          label={t("people.room.backdated")}
                        />
                      ) : null}
                    </span>
                    <span>
                      {t("people.room.period", {
                        from: formatDate(item.from) ?? "",
                        to: formatDate(item.to) ?? "",
                        open: item.to === null ? "yes" : "no",
                      })}
                    </span>
                    <span>{t("people.room.reasonShown", { reason: item.reason })}</span>
                    <span className="text-body-dense text-text-secondary">
                      {t("people.room.recorded", {
                        when: formatDateTime(item.recordedAt) ?? "",
                        by: whoDid(item.recordedBy, me.tenantUserId),
                      })}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </Card>

      {placement ? (
        <Card
          as="section"
          title={t("people.checklist.title")}
          description={t("people.checklist.progress", progress)}
          headingLevel={3}
        >
          <div className="flex flex-col gap-4">
            {checklist.safetyCriticalOutstanding.length > 0 ? (
              <Notice
                tone="warning"
                icon={<ShieldAlert size={20} strokeWidth={1.5} />}
                title={t("people.checklist.safetyOutstanding", {
                  count: checklist.safetyCriticalOutstanding.length,
                })}
              />
            ) : null}
            {!tickChecklist && checklistWriters.find((w) => w.readOnlyNotice) ? (
              <ReadOnlyNotice
                text={t(
                  checklistWriters.find((w) => w.readOnlyNotice)?.readOnlyNotice ??
                    "care.readOnly.scope",
                )}
              />
            ) : null}
            <ol className="m-0 flex list-none flex-col p-0">
              {checklistItems(checklist).map((item) => (
                <li
                  key={item.key}
                  className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{item.title}</span>
                    <StatusChip
                      status={checklistChip(item)}
                      label={t("people.checklist.state", {
                        status: item.status,
                        required: item.required ? "yes" : "no",
                      })}
                    />
                    {item.safetyCritical ? <SafetyCriticalChip /> : null}
                  </span>
                  {item.status !== "pending" && item.doneAt ? (
                    <span className="text-body-dense text-text-secondary">
                      {t("people.checklist.doneBy", {
                        when: formatDateTime(item.doneAt) ?? "",
                        by: whoDid(item.doneBy, me.tenantUserId),
                      })}
                    </span>
                  ) : null}
                  {item.status === "not_applicable" && item.reason ? (
                    <span>{t("people.checklist.reasonShown", { reason: item.reason })}</span>
                  ) : null}
                  {tickChecklist && mayTickChecklist(status) ? (
                    <ChecklistItemActions
                      personId={id}
                      itemKey={item.key}
                      title={item.title}
                      status={item.status}
                      allowNotApplicable={item.allowNotApplicable}
                      version={item.version}
                    />
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        </Card>
      ) : null}
    </>
  );
}

/** The tab inside the record's frame: the point-of-care header, read again on every tab. */
export default async function AdmissionPage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="admission">
      <AdmissionTab {...props} />
    </RecordFrame>
  );
}
