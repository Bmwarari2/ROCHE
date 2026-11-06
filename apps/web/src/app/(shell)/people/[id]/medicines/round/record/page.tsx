import { randomUUID } from "node:crypto";
import { Card, StatusChip } from "@harbour/ui";
import { Info, TriangleAlert, Zap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NoAccess } from "@/components/care/NoAccess";
import { Notice } from "@/components/care/Notice";
import { RecordFrame } from "@/components/care/RecordFrame";
import { PersonCheck } from "@/components/medicines/PersonCheck";
import { RecordDoseForm } from "@/components/medicines/RecordDoseForm";
import {
  ClockChange,
  CovertBeside,
  DoseNotices,
  EntryStatusNotice,
  PrnFigures,
  SelfAdminBeside,
} from "@/components/medicines/RoundDetails";
import { getShellContext, tenantApi } from "@/lib/api";
import { tabHref } from "@/lib/care-record";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  covertFor,
  doseChip,
  mayRecordDose,
  medicinesRoundShown,
  offeredAmount,
  personRoundHref,
  prescribedDose,
  selfAdministrationFor,
} from "@/lib/medicine-round";
import { getPerson, readOrFail } from "@/lib/person-record";
import { firstParam, recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("medicines", t("medicines.round.recordTitle"));
}

const iconProps = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * Recording one dose (slice 53; medicines.md section 16): the medicine as the round gives it, with
 * its entry's status and notices, the covert record beside it, and the person and every allergy at
 * the top of the form, so the person giving it compares them here (HZ-007; Harbour never matches
 * them, ADR-0082). A when-required medicine shows when it was last given, the 24-hour total and
 * when the next may be given (HZ-117). Only a dose on the person's round now can be recorded here.
 */
async function RecordDose({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await params;
  const query = await searchParams;
  const entryId = firstParam(query.entry);
  const dueAt = firstParam(query.due) ?? null;
  if (!entryId || !isUuid(entryId)) notFound();
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!medicinesRoundShown(me.permissions)) return <NoAccess />;
  const api = await tenantApi();
  const [round, record, covert, selfAdmin] = await Promise.all([
    api.GET("/v1/people/{id}/medicine-round", { params: { path: { id }, query: {} } }),
    api.GET("/v1/people/{id}/medicines", { params: { path: { id } } }),
    api.GET("/v1/people/{id}/covert-medicines", { params: { path: { id } } }),
    api.GET("/v1/people/{id}/self-administration", { params: { path: { id } } }),
  ]);
  const data = readOrFail(round, tabHref(id, "medicines"));
  if (!data) return <NoAccess />;
  const entry = (record.data?.entries ?? []).find((e) => e.id === entryId) ?? null;
  const dose = dueAt
    ? (data.doses.find((d) => d.entryId === entryId && d.dueAt === dueAt) ?? null)
    : null;
  const prn = dueAt ? null : (data.whenRequired.find((w) => w.entryId === entryId) ?? null);
  const back = (
    <p className="m-0">
      <Link href={personRoundHref(id)} className="inline-flex min-h-target items-center underline">
        {t("medicines.round.back")}
      </Link>
    </p>
  );
  // Only a dose late or due, not recorded and not waiting for review, may be recorded here (HZ-004).
  if (!entry || (!dose && !prn) || (dose && !mayRecordDose(dose))) {
    return (
      <>
        <Notice
          tone="warning"
          icon={<TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("medicines.round.notOnRound")}
        />
        {back}
      </>
    );
  }
  const prescribed = prescribedDose(entry, dose ? dose.time : null);
  const unit = prescribed?.unit ?? null;
  const covertRecord = covertFor(entry, covert.data?.items ?? []);
  const when = (iso: string) => formatDateTime(iso) ?? "";
  const product = dose?.productName ?? prn?.productName ?? entry.product.name;
  const chip = dose ? doseChip(dose.state, dose.stateInWords) : null;

  return (
    <>
      <Card as="section" title={t("medicines.round.recordFor", { product })} headingLevel={2}>
        <div className="flex flex-col gap-4">
          <Notice
            icon={<Info size={20} strokeWidth={1.5} aria-hidden="true" />}
            title={t("medicines.round.cdNotice")}
          />
          <section
            aria-label={t("medicines.round.medicineLabel")}
            className="flex flex-col gap-2 rounded-input border border-border p-3"
          >
            <p className="m-0 flex flex-wrap items-center gap-2">
              {chip ? (
                <StatusChip status={chip.status} label={chip.label} icon={chip.icon} />
              ) : null}
              <span className="font-semibold">{product}</span>
              <span>{dose ? dose.doseInWords : entry.directionsInWords}</span>
              <span>{entry.route.name}</span>
              {dose ? <span>{t("medicines.round.dueAt", { at: when(dose.dueAt) })}</span> : null}
              {dose?.timeCritical ? (
                <span className="inline-flex items-center gap-1 font-semibold">
                  <Zap {...iconProps} />
                  {t("medicines.round.timeCritical")}
                </span>
              ) : null}
            </p>
            {dose ? <ClockChange dose={dose} /> : null}
            {entry.indication ? (
              <p className="m-0">
                {t("medicines.round.indication", { indication: entry.indication })}
              </p>
            ) : null}
            {entry.specialInstructions ? (
              <p className="m-0 whitespace-pre-wrap">
                {t("medicines.round.instructions", { instructions: entry.specialInstructions })}
              </p>
            ) : null}
            {prn ? <PrnFigures prn={prn} unit={unit?.name ?? null} /> : null}
            <EntryStatusNotice status={entry.status} />
            <DoseNotices notices={dose?.notices ?? prn?.notices ?? []} />
            {!covert.data ? (
              <p className="m-0 font-semibold">{t("medicines.round.covertUnreadable")}</p>
            ) : (
              <CovertBeside record={covertRecord} />
            )}
            <SelfAdminBeside item={selfAdministrationFor(entry, selfAdmin.data?.medicines ?? [])} />
          </section>
          <RecordDoseForm
            personId={id}
            entryId={entryId}
            dueAt={dose ? dose.dueAt : null}
            recordId={randomUUID()}
            unitCode={unit?.code ?? null}
            unitName={unit?.name ?? null}
            offeredQuantity={offeredAmount(prescribed)}
            mayGive={entry.status.mayGive}
            covertRecordCurrent={covertRecord?.status === "current"}
            person={<PersonCheck person={person} />}
          />
        </div>
      </Card>
      {back}
    </>
  );
}

export default async function RecordDosePage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="medicines">
      <RecordDose {...props} />
    </RecordFrame>
  );
}
