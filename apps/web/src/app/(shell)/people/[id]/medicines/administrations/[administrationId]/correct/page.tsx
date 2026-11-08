import { randomUUID } from "node:crypto";
import { Card } from "@harbour/ui";
import { Info, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { NoAccess } from "@/components/care/NoAccess";
import { Notice } from "@/components/care/Notice";
import { RecordFrame } from "@/components/care/RecordFrame";
import { CdRecordingBanner } from "@/components/cd/CdRecordingBanner";
import { AdministrationCorrectionForm } from "@/components/medicines/ConflictForms";
import { recordWords } from "@/components/medicines/ConflictRecords";
import { PersonCheck } from "@/components/medicines/PersonCheck";
import {
  administrationsHref,
  conflictHref,
  correctHref,
  entryUnit,
} from "@/lib/administration-corrections";
import { getShellContext, tenantApi } from "@/lib/api";
import { tabHref } from "@/lib/care-record";
import { cdRecordingAt } from "@/lib/cd-recording";
import { isUuid } from "@/lib/context-cookies";
import { t } from "@/lib/i18n";
import { medicinesRoundShown } from "@/lib/medicine-round";
import { getPerson, readOrFail } from "@/lib/person-record";
import { firstParam, recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string; administrationId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("medicines", t("medicines.correct.title"));
}

/** How far back a record to correct is looked for: the most the API reads at once. */
const DAYS = 31;
const iconProps = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * Correcting an administration record (HZ-004; medicines.md 14.4), from a dose recorded twice or
 * from the person's records: the record as it stands, with the person and every allergy, then what
 * happened as corrected and why. The correction's client id is fixed in the address, so a resend
 * is the same correction and a controlled drug's witness signs for exactly it. Until controlled
 * drugs recording is turned on at the home, the paper register is the record (H-1517).
 */
async function Correct({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id, administrationId } = await params;
  if (!isUuid(administrationId)) notFound();
  const query = await searchParams;
  const conflictId = firstParam(query.conflict);
  const fromConflict = conflictId && isUuid(conflictId) ? conflictId : undefined;
  const recordId = firstParam(query.record);
  const here = correctHref(id, administrationId, fromConflict);
  if (!recordId || !isUuid(recordId)) {
    const join = here.includes("?") ? "&" : "?";
    redirect(`${here}${join}record=${randomUUID()}`);
  }
  const path = `${here}${here.includes("?") ? "&" : "?"}record=${recordId}`;
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!medicinesRoundShown(me.permissions)) return <NoAccess />;
  const api = await tenantApi();
  const to = new Date();
  const from = new Date(to.getTime() - DAYS * 86_400_000);
  const [read, record, pages, conflict, recordingOn] = await Promise.all([
    api.GET("/v1/people/{id}/medicine-administrations", {
      params: { path: { id }, query: { from: from.toISOString(), to: to.toISOString() } },
    }),
    api.GET("/v1/people/{id}/medicines", { params: { path: { id } } }),
    api.GET("/v1/people/{id}/controlled-drugs", { params: { path: { id } } }),
    fromConflict
      ? api.GET("/v1/medicine-administration-conflicts/{id}", {
          params: { path: { id: fromConflict } },
        })
      : null,
    cdRecordingAt(person.locationId),
  ]);
  const data = readOrFail(read, tabHref(id, "medicines"));
  if (!data) return <NoAccess />;
  const back = fromConflict
    ? conflictHref(person.locationId, fromConflict)
    : administrationsHref(id);
  const backLink = (
    <p className="m-0">
      <Link href={back} className="inline-flex min-h-target items-center underline">
        {t(fromConflict ? "medicines.correct.backToConflict" : "medicines.correct.back")}
      </Link>
    </p>
  );
  const original = data.administrations.find((a) => a.id === administrationId);
  const entry = original
    ? (record.data?.entries ?? []).find((e) => e.id === original.entryId)
    : undefined;
  if (!original || !entry || original.supersededById !== null) {
    return (
      <>
        <Notice
          tone="warning"
          icon={<TriangleAlert {...iconProps} />}
          title={t(
            original?.supersededById
              ? "medicines.correct.alreadyCorrected"
              : "medicines.correct.notFound",
            { days: DAYS },
          )}
        />
        {backLink}
      </>
    );
  }
  const unit = entryUnit(entry);
  const page = (pages.data?.pages ?? []).find((p) => p.vmpId === entry.product.vmpId) ?? null;
  // A controlled drug: its schedule on the MAR says so (so a dose not given, with no register
  // page yet, still asks for a witness), as do the conflict, a register page or the record.
  const controlledDrug =
    entry.controlledDrug ||
    Boolean(conflict?.data?.controlledDrug) ||
    page !== null ||
    original.inCdRegister;
  const waiting = page
    ? ((
        await api.GET("/v1/controlled-drugs/pages/{pageId}/witness-assertions", {
          params: { path: { pageId: page.id } },
        })
      ).data?.assertions ?? [])
    : [];

  return (
    <>
      {controlledDrug ? <CdRecordingBanner on={recordingOn} /> : null}
      <Card
        as="section"
        title={t("medicines.correct.recordFor", { product: entry.product.name })}
        headingLevel={2}
      >
        <div className="flex flex-col gap-4">
          <Notice icon={<Info {...iconProps} />} title={t("medicines.correct.intro")} />
          <section
            aria-label={t("medicines.correct.originalLabel")}
            className="flex flex-col gap-1 rounded-input border border-border p-3"
          >
            <p className="m-0 font-semibold">{t("medicines.correct.originalLabel")}</p>
            <p className="m-0">{recordWords(original, unit?.name ?? null)}</p>
          </section>
          <AdministrationCorrectionForm
            personId={id}
            original={original}
            recordId={recordId}
            unitCode={unit?.code ?? null}
            unitName={unit?.name ?? null}
            controlledDrug={controlledDrug}
            recordingOn={recordingOn}
            cdPageId={page?.id ?? null}
            recorderId={me.tenantUserId}
            waiting={waiting}
            loneAllowed={page?.witnessPolicy === "where_available"}
            path={path}
            done={back}
            person={<PersonCheck person={person} />}
          />
        </div>
      </Card>
      {backLink}
    </>
  );
}

export default async function CorrectPage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="medicines">
      <Correct {...props} />
    </RecordFrame>
  );
}
