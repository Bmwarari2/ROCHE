import { Card, StatusChip } from "@harbour/ui";
import type { ReactNode } from "react";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { type MedicationError, promptChip, reachedChip } from "@/lib/medication-errors";

type Row = readonly [field: string, value: string | null, dateTime?: string | null];

/** Labelled values, empty ones left out; a moment sits in a `<time>` element. */
function Fields({ rows }: { readonly rows: readonly Row[] }) {
  const shown = rows.filter(([, value]) => Boolean(value));
  if (shown.length === 0) return null;
  return (
    <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2">
      {shown.map(([field, value, dateTime]) => (
        <div key={field} className="min-w-0">
          <dt className="text-body-dense font-semibold">
            {t("medicines.errors.field", { field })}
          </dt>
          <dd className="m-0 whitespace-pre-line break-words">
            {dateTime ? <time dateTime={dateTime}>{value}</time> : value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The escalations the API returned with the record (medicines.md section 14.1; HZ-134), each as an
 * icon and its name with the API's own reason: clinical advice, the controlled drug report, the
 * safeguarding consideration and how CQC is decided. Harbour sends none of them; each goes once
 * its evidence is recorded, so what is listed is what is still to do.
 */
export function MedicationErrorEscalations({ error }: { readonly error: MedicationError }) {
  return (
    <Card as="section" title={t("medicines.errors.escalations")} headingLevel={2}>
      <div className="flex flex-col gap-3">
        <p className="m-0 max-w-prose">{t("medicines.errors.escalationsIntro")}</p>
        {error.prompts.length === 0 ? (
          <p className="m-0">{t("medicines.errors.nothingOutstanding")}</p>
        ) : null}
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {error.prompts.map((p) => {
            const chip = promptChip(p.prompt, t);
            return (
              <li key={p.prompt} className="flex flex-col gap-1 border-b border-border pb-3">
                <p className="m-0">
                  <StatusChip status={chip.status} label={chip.label} icon={chip.icon} />
                </p>
                <p className="m-0 max-w-prose">{p.reason}</p>
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}

/** What was recorded, as the API returns it: the kinds and stage in its words, with their source. */
export function MedicationErrorDetails({
  error,
  personName,
  personNeeds,
}: {
  readonly error: MedicationError;
  readonly personName: string | null;
  /** The person's communication needs (AIS), beside who the error is about. */
  readonly personNeeds?: ReactNode;
}) {
  const reached = reachedChip(error.nearMiss, t);
  const answer = (value: string | null) =>
    t("medicines.errors.answer", { answer: value ?? "none" });
  return (
    <Card as="section" title={t("medicines.errors.details")} headingLevel={2}>
      <div className="flex flex-col gap-4 break-words">
        <p className="m-0">
          <StatusChip status={reached.status} label={reached.label} icon={reached.icon} />
        </p>
        {personNeeds}
        <Fields
          rows={[
            ["person", personName],
            [
              "kinds",
              error.kindWords.length > 0
                ? error.kindWords.join("\n")
                : t("medicines.errors.noneRecorded"),
            ],
            ["stage", error.stageWords ?? t("medicines.errors.noneRecorded")],
            ["medicine", error.medicineName ?? t("medicines.errors.noneRecorded")],
            ["reachedPerson", answer(error.reachedPerson)],
            [
              "controlledDrug",
              error.controlledDrugPresumed
                ? t("medicines.errors.cdPresumed")
                : answer(error.controlledDrug),
            ],
            ["deliberateOrRepeated", answer(error.deliberateOrRepeated)],
            ["immediateActions", error.immediateActions],
            ["clinicianTold", error.clinicianTold],
            ["clinicianToldAt", formatDateTime(error.clinicianToldAt), error.clinicianToldAt],
            ["adviceGiven", error.adviceGiven],
            ["rootCause", error.rootCause],
            ["cdReportedOn", formatDate(error.cdReportedOn), error.cdReportedOn],
            ["cdReportReference", error.cdReportReference],
            ["recordedAt", formatDateTime(error.createdAt), error.createdAt],
          ]}
        />
        <p className="m-0 text-body-dense text-text-secondary">
          {t("medicines.errors.source", { source: error.source })}
        </p>
      </div>
    </Card>
  );
}
