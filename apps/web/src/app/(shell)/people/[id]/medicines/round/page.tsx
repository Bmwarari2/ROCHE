import { ButtonLink, Card, EmptyState, StatusChip } from "@harbour/ui";
import { ClipboardCheck, EyeOff, Pill, TriangleAlert, Zap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrivalNotice } from "@/components/care/ArrivalNotice";
import { NoAccess } from "@/components/care/NoAccess";
import { Notice } from "@/components/care/Notice";
import { RecordFrame } from "@/components/care/RecordFrame";
import { getShellContext, tenantApi } from "@/lib/api";
import { tabHref } from "@/lib/care-record";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  covertChip,
  covertFor,
  doseChip,
  medicinesRoundShown,
  recordDoseHref,
} from "@/lib/medicine-round";
import { medicinesHref } from "@/lib/medicines";
import { getPerson, readOrFail } from "@/lib/person-record";
import { firstParam, recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("medicines", t("medicines.round.personTitle"));
}

const iconProps = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * One person's medicines round (slice 53; MEDS-002 to MEDS-004; medicines.md section 16): the doses
 * due now and any earlier dose still late or due, each with its state as an icon and a word, its
 * entry's status and notices, and the covert record for the medicine beside it (its status, how it
 * is given and the pharmacist's advice; H-1354); and the when-required medicines that may be given
 * now, with when last given, the 24-hour total and when the next may be given (HZ-117). Each links
 * to the page that records it, where the person and every allergy are beside the medicine (HZ-007).
 */
async function PersonRound({
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
  if (!medicinesRoundShown(me.permissions)) return <NoAccess />;
  const api = await tenantApi();
  const [round, record, covert] = await Promise.all([
    api.GET("/v1/people/{id}/medicine-round", { params: { path: { id }, query: {} } }),
    api.GET("/v1/people/{id}/medicines", { params: { path: { id } } }),
    api.GET("/v1/people/{id}/covert-medicines", { params: { path: { id } } }),
  ]);
  const data = readOrFail(round, tabHref(id, "medicines"));
  if (!data) return <NoAccess />;
  const entries = new Map((record.data?.entries ?? []).map((e) => [e.id, e]));
  const covertRecords = covert.data?.items ?? [];
  const done = firstParam((await searchParams).done);
  const when = (iso: string) => formatDateTime(iso) ?? "";

  const covertBeside = (entryId: string) => {
    const entry = entries.get(entryId);
    const found = entry ? covertFor(entry, covertRecords) : null;
    if (!found) return null;
    const chip = covertChip(found);
    return (
      <div className="flex flex-col gap-1 rounded-input border border-border p-2">
        <p className="m-0 flex flex-wrap items-center gap-2">
          <EyeOff {...iconProps} />
          <span className="font-semibold">{t("medicines.round.covert.title")}</span>
          <StatusChip status={chip.status} label={chip.label} icon={chip.icon} />
        </p>
        <p className="m-0">{t("medicines.round.covert.method", { method: found.method })}</p>
        <p className="m-0">
          {t("medicines.round.covert.advice", { advice: found.pharmacistAdvice })}
        </p>
      </div>
    );
  };

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("medicines.round.personTitle")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">{t("medicines.round.personIntro")}</p>
      </div>
      {done === "recorded" ? <ArrivalNotice>{t("medicines.round.form.done")}</ArrivalNotice> : null}
      <Card as="section" title={t("medicines.round.doses")} headingLevel={3}>
        {data.doses.length === 0 ? (
          <EmptyState
            icon={<Pill {...iconProps} />}
            title={t("medicines.round.noDoses")}
            description={t("medicines.round.noDosesAbout")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {data.doses.map((dose) => {
              const chip = doseChip(dose.state, dose.stateInWords);
              return (
                <li
                  key={`${dose.entryId}-${dose.dueAt}`}
                  className="flex flex-col gap-2 border-b border-border pb-3"
                >
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    <StatusChip status={chip.status} label={chip.label} icon={chip.icon} />
                    <span className="font-semibold">{dose.productName}</span>
                    <span>{dose.doseInWords}</span>
                    <span>{t("medicines.round.dueAt", { at: when(dose.dueAt) })}</span>
                    {dose.dayName ? <span>{dose.dayName}</span> : null}
                    {dose.timeCritical ? (
                      <span className="inline-flex items-center gap-1 font-semibold">
                        <Zap {...iconProps} />
                        {t("medicines.round.timeCritical")}
                      </span>
                    ) : null}
                  </p>
                  {dose.clockChange ? (
                    <p className="m-0">
                      {t("medicines.round.clockChange", { change: dose.clockChange })}
                    </p>
                  ) : null}
                  {!dose.entryStatus.mayGive || dose.entryStatus.notice ? (
                    <Notice
                      tone="warning"
                      icon={<TriangleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
                      title={dose.entryStatus.words}
                    >
                      {dose.entryStatus.notice}
                    </Notice>
                  ) : null}
                  {dose.notices.length > 0 ? (
                    <ul className="m-0 flex flex-col gap-1 pl-5">
                      {dose.notices.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  ) : null}
                  {dose.reviewInWords ? <p className="m-0">{dose.reviewInWords}</p> : null}
                  {covertBeside(dose.entryId)}
                  {dose.state !== "recorded" &&
                  dose.state !== "not_yet_due" &&
                  !dose.reviewPending ? (
                    <p className="m-0">
                      <ButtonLink
                        href={recordDoseHref(id, dose.entryId, dose.dueAt)}
                        variant="secondary"
                        icon={<ClipboardCheck {...iconProps} />}
                      >
                        {t("medicines.round.record", { product: dose.productName })}
                      </ButtonLink>
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card as="section" title={t("medicines.round.prn")} headingLevel={3}>
        {data.whenRequired.length === 0 ? (
          <p className="m-0">{t("medicines.round.noPrn")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {data.whenRequired.map((prn) => (
              <li key={prn.entryId} className="flex flex-col gap-2 border-b border-border pb-3">
                <p className="m-0 font-semibold">{prn.productName}</p>
                <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                  <dt className="font-semibold">{t("medicines.round.prnLast")}</dt>
                  <dd className="m-0">
                    {prn.lastGiven
                      ? t(
                          prn.lastGiven.synced
                            ? "medicines.round.prnLastAt"
                            : "medicines.round.prnLastAtUnsynced",
                          { at: when(prn.lastGiven.at) },
                        )
                      : t("medicines.round.notGiven")}
                  </dd>
                  <dt className="font-semibold">{t("medicines.round.prn24")}</dt>
                  <dd className="m-0">
                    {prn.maxPer24Hours === null
                      ? t("medicines.round.prn24NoMax", { count: prn.givenInLast24Hours })
                      : t("medicines.round.prn24Max", {
                          count: prn.givenInLast24Hours,
                          max: prn.maxPer24Hours,
                        })}
                  </dd>
                  <dt className="font-semibold">{t("medicines.round.prnNext")}</dt>
                  <dd className="m-0">
                    {prn.nextAllowedAt
                      ? t("medicines.round.prnNextAt", { at: when(prn.nextAllowedAt) })
                      : t("medicines.round.prnNextNow")}
                  </dd>
                </dl>
                {prn.notices.length > 0 ? (
                  <ul className="m-0 flex flex-col gap-1 pl-5">
                    {prn.notices.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                ) : null}
                {covertBeside(prn.entryId)}
                <p className="m-0">
                  <ButtonLink
                    href={recordDoseHref(id, prn.entryId, null)}
                    variant="secondary"
                    icon={<ClipboardCheck {...iconProps} />}
                  >
                    {t("medicines.round.recordPrn", { product: prn.productName })}
                  </ButtonLink>
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className="m-0">
        <Link href={medicinesHref(id)} className="inline-flex min-h-target items-center underline">
          {t("medicines.back")}
        </Link>
      </p>
    </>
  );
}

export default async function PersonRoundPage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="medicines">
      <PersonRound {...props} />
    </RecordFrame>
  );
}
