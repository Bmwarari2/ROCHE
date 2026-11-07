import { randomUUID } from "node:crypto";
import { Card, EmptyState, StatusChip } from "@harbour/ui";
import { CircleCheck, CircleX, Pill, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrivalNotice } from "@/components/care/ArrivalNotice";
import { NoAccess } from "@/components/care/NoAccess";
import { Notice } from "@/components/care/Notice";
import { RecordFrame } from "@/components/care/RecordFrame";
import { EnteredInErrorForm } from "@/components/medicines/homely/EnteredInErrorForm";
import { HomelyDoseForm } from "@/components/medicines/homely/HomelyDoseForm";
import { PersonCheck } from "@/components/medicines/PersonCheck";
import { getShellContext, tenantApi } from "@/lib/api";
import { tabHref } from "@/lib/care-record";
import { formatDateTime } from "@/lib/format";
import {
  currentMedicines,
  doseRows,
  HOMELY_GIVER,
  homelyShown,
  mayMarkInError,
  usableProtocols,
} from "@/lib/homely-remedies";
import { t } from "@/lib/i18n";
import { medicinesHref } from "@/lib/medicines";
import { getPerson, readOrFail } from "@/lib/person-record";
import { firstParam, recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("medicines", t("medicines.homely.personTitle"));
}

const iconProps = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;

/**
 * A person's homely remedies (slice 55; MEDS-007; medicines.md section 15.3; HZ-120, HZ-007): the
 * doses given under the home's protocols, newest first, each with the amount, when, why and any
 * flags; a dose entered in error stays, struck through, with the reason. Someone who may give
 * homely remedies records one here: the person and every allergy beside the form, the protocol's
 * figures beside the choice, and a check with the API, in its words, before it is recorded.
 */
async function PersonHomely({
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
  if (!homelyShown(me.permissions)) return <NoAccess />;
  const api = await tenantApi();
  const [doses, protocols, medicines] = await Promise.all([
    api.GET("/v1/people/{id}/homely-remedy-doses", { params: { path: { id } } }),
    api.GET("/v1/locations/{id}/homely-remedies", { params: { path: { id: person.locationId } } }),
    api.GET("/v1/people/{id}/medicines", { params: { path: { id } } }),
  ]);
  const data = readOrFail(doses, tabHref(id, "medicines"));
  if (!data) return <NoAccess />;
  const reaching = person.access?.reaching ?? me.permissions;
  const mayGive = reaching.includes(HOMELY_GIVER);
  const usable = usableProtocols(protocols.data?.items ?? []);
  const rows = doseRows(data.items);
  const query = await searchParams;
  const done = firstParam(query.done);
  const at = firstParam(query.at) ?? "first";
  const when = (iso: string) => formatDateTime(iso) ?? "";

  return (
    <>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-eyebrow">{t("medicines.homely.personTitle")}</h2>
        <p className="m-0 max-w-prose text-text-secondary">{t("medicines.homely.personIntro")}</p>
      </div>
      {done === "recorded" ? (
        <ArrivalNotice key={at}>{t("medicines.homely.dose.done")}</ArrivalNotice>
      ) : done === "marked" ? (
        <ArrivalNotice key={at}>{t("medicines.homely.error.done")}</ArrivalNotice>
      ) : null}
      {mayGive ? (
        <Card as="section" title={t("medicines.homely.dose.title")} headingLevel={3}>
          {!protocols.data ? (
            <Notice
              tone="warning"
              icon={<TriangleAlert {...iconProps} />}
              title={t("medicines.homely.protocolsUnreadable")}
            />
          ) : usable.length === 0 ? (
            <div className="flex flex-col gap-4">
              <PersonCheck person={person} />
              <p className="m-0">{t("medicines.homely.dose.noProtocols")}</p>
            </div>
          ) : (
            <HomelyDoseForm
              // Each arrival starts a fresh form, not the last dose's check and its "recorded".
              key={at}
              personId={id}
              protocols={usable}
              recordId={randomUUID()}
              person={<PersonCheck person={person} />}
              currentMedicines={
                // What the person takes now, to compare with the remedy (HZ-120).
                <section aria-labelledby="homely-current" className="flex flex-col gap-2">
                  <h4 id="homely-current" className="m-0 text-body font-semibold">
                    {t("medicines.homely.dose.currentTitle")}
                  </h4>
                  {!medicines.data ? (
                    <p className="m-0 inline-flex items-start gap-2 font-semibold">
                      <TriangleAlert {...iconProps} />
                      {t("medicines.homely.dose.currentUnreadable")}
                    </p>
                  ) : currentMedicines(medicines.data.entries).length === 0 ? (
                    <p className="m-0">{t("medicines.homely.dose.currentNone")}</p>
                  ) : (
                    <ul className="m-0 flex flex-col gap-1 pl-5">
                      {currentMedicines(medicines.data.entries).map((m) => (
                        <li key={`${m.product}-${m.directions}`}>
                          {t("medicines.homely.dose.currentItem", m)}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              }
            />
          )}
        </Card>
      ) : null}
      <Card as="section" title={t("medicines.homely.doses")} headingLevel={3}>
        {rows.length === 0 ? (
          <EmptyState
            headingLevel={4}
            icon={<Pill {...iconProps} />}
            title={t("medicines.homely.noDoses")}
            description={t("medicines.homely.noDosesAbout")}
          />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {rows.map(({ dose, correction }) => {
              const struck = dose.enteredInErrorBy !== null;
              return (
                <li key={dose.id} className="flex flex-col gap-2 border-b border-border pb-3">
                  <p className="m-0 flex flex-wrap items-center gap-2">
                    {struck ? (
                      <StatusChip
                        status="notApplicable"
                        icon={CircleX}
                        label={t("medicines.homely.enteredInError")}
                      />
                    ) : (
                      <StatusChip
                        status="done"
                        icon={CircleCheck}
                        label={t("medicines.homely.given")}
                      />
                    )}
                    <span className={struck ? "line-through" : undefined}>
                      {t("medicines.homely.doseLine", {
                        product: dose.productName,
                        // A missing quantity says so, never as zero (clinical review).
                        amount:
                          dose.quantity === null
                            ? t("medicines.homely.quantityNotRecorded")
                            : t("medicines.stock.balance", {
                                balance: dose.quantity,
                                unit: dose.unitName,
                              }),
                        at: when(dose.givenAt),
                      })}
                    </span>
                  </p>
                  {dose.reason ? (
                    <p className={`m-0 ${struck ? "line-through" : ""}`}>
                      {t("medicines.homely.doseReason", { reason: dose.reason })}
                    </p>
                  ) : null}
                  {dose.givenBy === me.tenantUserId ? (
                    <p className="m-0">{t("medicines.homely.givenByYou")}</p>
                  ) : null}
                  {dose.alreadyGivenReason ? (
                    <p className="m-0">
                      {t("medicines.homely.recordedAfter", {
                        at: when(dose.recordedAt),
                        reason: dose.alreadyGivenReason,
                      })}
                    </p>
                  ) : null}
                  {dose.flags.length > 0 ? (
                    <div className="flex flex-col gap-1">
                      <p className="m-0 inline-flex items-center gap-2 font-semibold">
                        <TriangleAlert size={18} strokeWidth={1.5} aria-hidden="true" />
                        {t("medicines.homely.flagsTitle")}
                      </p>
                      <ul className="m-0 flex flex-col gap-1 pl-5">
                        {dose.flags.map((flag) => (
                          <li key={flag}>{t("medicines.homely.flag", { flag })}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {correction ? (
                    <p className="m-0">
                      {t("medicines.homely.markedBecause", {
                        at: when(correction.recordedAt),
                        reason: correction.correctionReason ?? "",
                      })}
                    </p>
                  ) : null}
                  {mayMarkInError(dose, {
                    tenantUserId: me.tenantUserId,
                    permissions: reaching,
                  }) ? (
                    <EnteredInErrorForm personId={id} doseId={dose.id} product={dose.productName} />
                  ) : null}
                </li>
              );
            })}
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

export default async function PersonHomelyPage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="medicines">
      <PersonHomely {...props} />
    </RecordFrame>
  );
}
