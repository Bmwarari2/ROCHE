import type { HospitalTransferOut } from "@harbour/contracts";
import { Card, StatusChip } from "@harbour/ui";
import { CircleCheck, Clock, Printer } from "lucide-react";
import type { Metadata } from "next";
import { ArrivalNotice } from "@/components/care/ArrivalNotice";
import { NoAccess } from "@/components/care/NoAccess";
import { ReadOnlyNotice } from "@/components/care/ReadOnlyNotice";
import { RecordFrame } from "@/components/care/RecordFrame";
import {
  HandoverForm,
  ReturnCheckButton,
  ReturnForm,
  SendToHospitalForm,
} from "@/components/people/HospitalForms";
import { TransferPackView } from "@/components/people/TransferPackView";
import { getShellContext, tenantApi } from "@/lib/api";
import { can, tabHref, writeAccess } from "@/lib/care-record";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { problemMessage } from "@/lib/outcome";
import { getPerson } from "@/lib/person-record";
import { firstParam, recordMetadata } from "@/lib/record-metadata";
import { needsAcknowledgement, openTransfer, packIdentity } from "@/lib/transfer-pack";
import { ukToday } from "@/lib/uk-time";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The page title names the tab, never the person. */
export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("hospital");
}

const pdfHref = (personId: string, transferId: string) =>
  `${tabHref(personId, "hospital")}/${transferId}/pdf`;

const DONE_MESSAGES = {
  sent: "people.transfer.send.done",
  handover: "people.transfer.handover.saved",
  returned: "people.transfer.return.saved",
  check: "people.transfer.checks.saved",
} as const;

function WrongPerson() {
  return (
    <p role="alert" className="m-0 max-w-prose font-semibold" data-pack-wrong-person="">
      {t("people.transfer.wrongPerson")}
    </p>
  );
}

/** The pack sent with the person, the print link and the hand-over (HZ-001, HZ-023). */
function AwayCard({
  personId,
  transfer,
  canWrite,
}: {
  readonly personId: string;
  readonly transfer: HospitalTransferOut;
  readonly canWrite: boolean;
}) {
  const identity = packIdentity(transfer.pack, personId);
  return (
    <Card
      as="section"
      title={t("people.transfer.away.title", { hospital: transfer.hospitalName })}
      headingLevel={3}
    >
      <div className="flex flex-col gap-4">
        <p className="m-0">
          {t("people.transfer.away.left", { dateTime: formatDateTime(transfer.leftAt) ?? "" })}
        </p>
        {identity ? (
          <>
            <div className="flex flex-col gap-2">
              <div>
                {/* A plain link: the PDF downloads, so client-side navigation must not take it. */}
                <a
                  href={pdfHref(personId, transfer.id)}
                  className="hb-button hb-button--primary"
                  data-pack-print=""
                >
                  <Printer size={18} strokeWidth={1.5} aria-hidden="true" />
                  <span className="hb-button__label">{t("people.transfer.print")}</span>
                </a>
              </div>
              <p className="m-0 max-w-prose text-body-dense">{t("people.transfer.printHint")}</p>
            </div>
            <h4 className="m-0 text-body font-semibold">{t("people.transfer.sentTitle")}</h4>
            <TransferPackView pack={transfer.pack} identity={identity} />
          </>
        ) : (
          <WrongPerson />
        )}
        <section aria-labelledby="pack-handover" className="flex flex-col gap-2">
          <h4 id="pack-handover" className="m-0 text-body font-semibold">
            {t("people.transfer.handover.title")}
          </h4>
          {transfer.handedOverAt ? (
            <>
              <p className="m-0 flex items-center gap-2" data-pack-handed-over="">
                <CircleCheck size={18} strokeWidth={1.5} aria-hidden="true" />
                {t("people.transfer.handover.done", {
                  dateTime: formatDateTime(transfer.handedOverAt) ?? "",
                })}
              </p>
              {transfer.acknowledgement ? (
                <p className="m-0">
                  {t("people.transfer.handover.acknowledged", {
                    reason: transfer.acknowledgement.reason,
                  })}
                </p>
              ) : null}
            </>
          ) : canWrite && identity ? (
            <HandoverForm
              personId={personId}
              transferId={transfer.id}
              version={transfer.version}
              needsAcknowledgement={needsAcknowledgement(transfer)}
            />
          ) : null}
        </section>
      </div>
    </Card>
  );
}

/** The checks on return still to do and done, each one recorded by someone who may (rule 10). */
function ReturnChecks({
  personId,
  transfer,
  canCheck,
}: {
  readonly personId: string;
  readonly transfer: HospitalTransferOut;
  readonly canCheck: boolean;
}) {
  return (
    <Card as="section" title={t("people.transfer.checks.title")} headingLevel={3}>
      <ul className="m-0 flex list-none flex-col gap-4 p-0">
        {transfer.returnChecks.map((check) => {
          const label = t("people.transfer.checks.check", { key: check.key, title: check.title });
          return (
            <li key={check.key} className="flex flex-col gap-1" data-return-check={check.key}>
              <p className="m-0 flex flex-wrap items-center gap-2">
                <span className="font-semibold">{label}</span>
                {check.doneAt ? (
                  <StatusChip
                    status="done"
                    label={t("people.transfer.checks.done")}
                    icon={CircleCheck}
                  />
                ) : (
                  <StatusChip status="due" label={t("people.transfer.checks.toDo")} icon={Clock} />
                )}
              </p>
              {check.doneAt ? (
                <p className="m-0 text-body-dense">
                  {t("people.transfer.checks.doneAt", {
                    dateTime: formatDateTime(check.doneAt) ?? "",
                  })}
                </p>
              ) : (
                <>
                  {check.dueAt ? (
                    <p className="m-0 text-body-dense">
                      {t("people.transfer.checks.due", {
                        dateTime: formatDateTime(check.dueAt) ?? "",
                      })}
                    </p>
                  ) : null}
                  {canCheck ? (
                    <ReturnCheckButton
                      personId={personId}
                      transferId={transfer.id}
                      checkKey={check.key}
                      checkLabel={label}
                      version={transfer.version}
                    />
                  ) : null}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/**
 * The hospital tab (people.md rule 10 and section 6a; PEOP-009; HZ-001, HZ-023). Before a
 * transfer, the pack as it would be made now and the one form that sends the person with it; while
 * they are away, the pack as sent with its PDF, the hand-over and the return; after they come back,
 * the checks on return; and the earlier transfers with their packs.
 */
async function HospitalTab({
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
  if (!can(me.permissions, "people.movement.record")) return <NoAccess />;
  const query = await searchParams;
  const done = firstParam(query.done);
  const at = firstParam(query.at) ?? "first";
  const print = firstParam(query.print);
  const api = await tenantApi();
  const transfers = await api.GET("/v1/people/{id}/hospital-transfers", {
    params: { path: { id } },
  });
  const items = transfers.data?.items ?? [];
  const away = openTransfer(items);
  const latest = items[0] ?? null;
  const afterReturn = latest && latest.returnedAt !== null ? latest : null;
  const earlier = items.filter((item) => item.returnedAt !== null);
  const { canWrite, readOnlyNotice } = writeAccess(
    person,
    me.permissions,
    "people.movement.record",
  );
  const canCheck = canWrite || writeAccess(person, me.permissions, "care.plan.write").canWrite;

  // The pack as it would be made now, only while there is no transfer under way.
  const [preview, property] =
    transfers.data && !away && person.status !== "in_hospital"
      ? await Promise.all([
          api.GET("/v1/people/{id}/transfer-pack", { params: { path: { id } } }),
          api.GET("/v1/people/{id}/property", { params: { path: { id } } }),
        ])
      : [null, null];
  const previewIdentity = preview?.data ? packIdentity(preview.data, id) : null;
  const toSend = property?.data
    ? property.data.items
        .filter((item) => property.data.toSendWithPerson.includes(item.id))
        .map((item) => ({ id: item.id, description: item.description }))
    : [];
  const doneKey =
    done && done in DONE_MESSAGES ? DONE_MESSAGES[done as keyof typeof DONE_MESSAGES] : null;

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("people.transfer.title")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">{t("people.transfer.intro")}</p>
      </div>
      {doneKey ? <ArrivalNotice key={`${done}-${at}`}>{t(doneKey)}</ArrivalNotice> : null}
      {print === "busy" || print === "failed" ? (
        <p role="alert" className="m-0 max-w-prose font-semibold">
          {t("people.transfer.printFailed", { reason: print })}
        </p>
      ) : null}
      {!transfers.data ? (
        <p role="alert" className="m-0 font-semibold">
          {problemMessage(transfers.error, t).message || t("people.transfer.unavailable")}
        </p>
      ) : away ? (
        <>
          <AwayCard personId={id} transfer={away} canWrite={canWrite} />
          {canWrite ? (
            <Card as="section" title={t("people.transfer.return.title")} headingLevel={3}>
              <ReturnForm personId={id} transferId={away.id} version={away.version} />
            </Card>
          ) : null}
        </>
      ) : person.status === "in_hospital" ? (
        <p className="m-0 max-w-prose">{t("people.transfer.inHospitalElsewhere")}</p>
      ) : (
        <>
          {afterReturn?.returnChecks.some((check) => check.doneAt === null) ? (
            <ReturnChecks personId={id} transfer={afterReturn} canCheck={canCheck} />
          ) : null}
          <Card as="section" title={t("people.transfer.previewTitle")} headingLevel={3}>
            {preview?.data ? (
              previewIdentity ? (
                <TransferPackView pack={preview.data} identity={previewIdentity} />
              ) : (
                <WrongPerson />
              )
            ) : (
              <p role="alert" className="m-0 max-w-prose font-semibold" data-pack-refused="">
                {t("people.transfer.previewUnavailable", {
                  detail: problemMessage(preview?.error, t).message,
                })}
              </p>
            )}
          </Card>
          {preview?.data && previewIdentity ? (
            canWrite ? (
              <Card as="section" title={t("people.transfer.send.title")} headingLevel={3}>
                <SendToHospitalForm personId={id} version={person.version} items={toSend} />
              </Card>
            ) : readOnlyNotice ? (
              <ReadOnlyNotice text={t(readOnlyNotice)} />
            ) : null
          ) : null}
        </>
      )}
      {transfers.data ? (
        <Card as="section" title={t("people.transfer.historyTitle")} headingLevel={3}>
          {earlier.length === 0 ? (
            <p className="m-0">{t("people.transfer.historyNone")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {earlier.map((item) => (
                <li key={item.id} className="flex flex-col gap-1" data-transfer={item.id}>
                  <p className="m-0">
                    {t("people.transfer.historyLine", {
                      hospital: item.hospitalName,
                      left: formatDateTime(item.leftAt) ?? "",
                      back: formatDateTime(item.returnedAt) ?? "",
                    })}
                  </p>
                  <a
                    href={pdfHref(id, item.id)}
                    className="inline-flex min-h-target items-center self-start underline"
                  >
                    {t("people.transfer.historyPrint", {
                      date: formatDate(ukToday(new Date(item.leftAt))) ?? "",
                    })}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}
    </>
  );
}

/** The tab inside the record's frame: the point-of-care header, read again on every tab. */
export default async function HospitalPage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="hospital">
      <HospitalTab {...props} />
    </RecordFrame>
  );
}
