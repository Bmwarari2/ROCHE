import { Card, PageHeader } from "@harbour/ui";
import { Info, Lock, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ArrivalNotice } from "@/components/care/ArrivalNotice";
import { Notice } from "@/components/care/Notice";
import {
  MedicationErrorDetails,
  MedicationErrorEscalations,
} from "@/components/medicines/errors/MedicationErrorDetails";
import {
  type Choice,
  MedicationErrorForm,
} from "@/components/medicines/errors/MedicationErrorForm";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { failWith, getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { incidentTitle } from "@/lib/incidents";
import {
  errorRecordShown,
  errorRecordWritable,
  medicationErrorHref,
} from "@/lib/medication-errors";
import { personNames, sampleName } from "@/lib/people";
import { firstParam } from "@/lib/record-metadata";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export const metadata: Metadata = { title: t("medicines.errors.title") };

const iconProps = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;
const DAY = 86_400_000;

/**
 * The medication error on a medication incident (slice 55; MEDS-012; medicines.md section 14.1;
 * HZ-134): the details as recorded, the escalations in the API's words (clinical advice, the
 * controlled drug report, the safeguarding consideration, and how CQC is decided), and the form
 * that adds or changes them. Reading needs `safety.incident.read` (the API adds MFA and refuses a
 * restricted incident whole); adding and changing need `safety.incident.report`, and the API allows
 * only the raiser, a manager of incidents there, or the member who added the record, never on a
 * closed incident. Harbour sends nothing to a clinician, the CDAO, a local authority or CQC.
 */
export default async function MedicationErrorPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const query = await searchParams;
  const done = firstParam(query.done);
  const chosen = firstParam(query.person);
  const { me } = await getShellContext();
  const title = t("medicines.errors.title");
  if (!errorRecordShown(me.permissions)) return <SafetyForbidden title={title} />;
  const api = await tenantApi();
  const read = await api.GET("/v1/incidents/{id}", { params: { path: { id } } });
  if (problemCode(read.error) === "not_found") notFound();
  if (problemCode(read.error) === "missing_permission") return <SafetyForbidden title={title} />;
  if (!read.data) failWith(read.error, read.response, medicationErrorHref(id));
  const incident = read.data;
  const incidentName = incidentTitle(incident, t);
  const location = me.locations.find((l) => l.id === incident.locationId);

  const header = (
    <>
      <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
        <Link href="/incidents" className="underline">
          {t("safety.incidents.title")}
        </Link>
        <span aria-hidden="true" className="px-2 text-text-secondary">
          ›
        </span>
        <Link href={`/incidents/${id}`} className="underline">
          {incidentName}
        </Link>
        <span aria-hidden="true" className="px-2 text-text-secondary">
          ›
        </span>
        <span aria-current="page">{title}</span>
      </nav>
      <PageHeader
        eyebrow={location?.name ?? t("safety.incident.locationHidden")}
        title={title}
        description={t("medicines.errors.description", { incident: incidentName })}
      />
    </>
  );
  const back = (
    <p className="m-0">
      <Link href={`/incidents/${id}`} className="inline-flex min-h-target items-center underline">
        {t("medicines.errors.backToIncident")}
      </Link>
    </p>
  );
  const page = (body: ReactNode) => (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6">
      {header}
      {body}
      {back}
    </div>
  );

  if (incident.restricted)
    return page(<Notice icon={<Lock {...iconProps} />} title={t("medicines.errors.restricted")} />);
  if (incident.type !== "medication")
    return page(
      <Notice icon={<Info {...iconProps} />} title={t("medicines.errors.notMedication")} />,
    );

  const record = await api.GET("/v1/incidents/{id}/medication-error", {
    params: { path: { id } },
  });
  if (problemCode(record.error) === "not_found") notFound();
  if (problemCode(record.error) === "missing_permission") return <SafetyForbidden title={title} />;
  if (!record.data) failWith(record.error, record.response, medicationErrorHref(id));
  const current = record.data.error;

  // The people we support on it, named from the reader's own list.
  const list = await api.GET("/v1/people", { params: { query: {} } });
  const names = new Map(
    (list.data?.items ?? []).map((p) => [p.id, sampleName(p, personNames(p).full, t)]),
  );
  const nameOf = (personId: string) => names.get(personId) ?? t("medicines.errors.someone");
  const onIncident = incident.people
    .filter((p) => p.kind === "service_user" && p.personId)
    .map((p) => p.personId as string);

  const closed = incident.status === "closed";
  const manages = me.permissions.includes("safety.incident.manage");
  const mayWrite =
    errorRecordWritable(me.permissions) &&
    !closed &&
    (manages ||
      incident.raisedBy === me.tenantUserId ||
      (current !== null && current.createdBy === me.tenantUserId));
  // The person the form is about: the record's, the one on the incident, or the one chosen.
  const formPerson =
    current?.personId ??
    (onIncident.length === 1
      ? onIncident[0]
      : chosen && onIncident.includes(chosen)
        ? chosen
        : undefined);

  let form: ReactNode = null;
  if (mayWrite && formPerson) {
    const occurred = Date.parse(incident.occurredAt);
    const [medicines, doses] = await Promise.all([
      api.GET("/v1/people/{id}/medicines", { params: { path: { id: formPerson } } }),
      api.GET("/v1/people/{id}/medicine-administrations", {
        params: {
          path: { id: formPerson },
          query: {
            from: new Date(occurred - DAY).toISOString(),
            to: new Date(Math.min(occurred + DAY, Date.now())).toISOString(),
          },
        },
      }),
    ]);
    const entries = medicines.data?.entries ?? [];
    const productOf = new Map(entries.map((e) => [e.id, e.product.name]));
    const medicineChoices: Choice[] | null = medicines.data
      ? entries.map((e) => ({
          value: e.id,
          label: t("medicines.errors.form.medicineOption", {
            name: e.product.name,
            directions: e.directionsInWords,
          }),
        }))
      : null;
    // A recorded medicine no longer listed stays offered, by the name the API gives it.
    if (medicineChoices && current?.medicationId && !productOf.has(current.medicationId)) {
      medicineChoices.push({
        value: current.medicationId,
        label: current.medicineName ?? t("medicines.errors.form.recordedMedicine"),
      });
    }
    const doseChoices: Choice[] | null = doses.data
      ? doses.data.administrations
          .filter((a) => a.supersededById === null || a.id === current?.administrationId)
          .map((a) => ({
            value: a.id,
            label: t("medicines.errors.form.doseOption", {
              medicine: productOf.get(a.entryId) ?? t("medicines.errors.form.recordedMedicine"),
              outcome: a.outcomeInWords,
              at: formatDateTime(a.givenAt) ?? "",
            }),
          }))
      : null;
    if (
      doseChoices &&
      current?.administrationId &&
      !doseChoices.some((c) => c.value === current.administrationId)
    ) {
      doseChoices.push({
        value: current.administrationId,
        label: t("medicines.errors.form.recordedDose"),
      });
    }
    form = (
      <Card
        as="section"
        title={t("medicines.errors.formTitle", { mode: current ? "change" : "add" })}
        headingLevel={2}
      >
        <MedicationErrorForm
          incidentId={id}
          occurredAt={incident.occurredAt}
          people={[{ value: formPerson, label: nameOf(formPerson) }]}
          medicines={medicineChoices}
          doseRecords={doseChoices}
          current={current}
        />
      </Card>
    );
  }

  return page(
    <>
      {done === "added" || done === "changed" ? (
        <ArrivalNotice>{t("medicines.errors.done", { done })}</ArrivalNotice>
      ) : null}
      {closed ? (
        <Notice icon={<Lock {...iconProps} />} title={t("medicines.errors.closed")} />
      ) : null}
      {current ? (
        <>
          <MedicationErrorEscalations error={current} />
          <MedicationErrorDetails error={current} personName={nameOf(current.personId)} />
        </>
      ) : (
        <Notice
          tone="warning"
          icon={<TriangleAlert {...iconProps} />}
          title={t("medicines.errors.none")}
        >
          {mayWrite ? t("medicines.errors.noneHint") : t("medicines.errors.noneReadOnly")}
        </Notice>
      )}
      {mayWrite && !formPerson && onIncident.length > 1 ? (
        <Card as="section" title={t("medicines.errors.choosePerson")} headingLevel={2}>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {onIncident.map((personId) => (
              <li key={personId}>
                <Link
                  href={`${medicationErrorHref(id)}?person=${personId}`}
                  className="inline-flex min-h-target items-center underline"
                >
                  {t("medicines.errors.recordFor", { name: nameOf(personId) })}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {mayWrite && onIncident.length === 0 && !current ? (
        <Notice icon={<Info {...iconProps} />} title={t("medicines.errors.nobodyOnIncident")} />
      ) : null}
      {form}
    </>,
  );
}
