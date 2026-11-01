import { ButtonLink, Card } from "@harbour/ui";
import { Printer } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NoAccess } from "@/components/care/NoAccess";
import { RecordFrame } from "@/components/care/RecordFrame";
import { CorrectionForm, EntryForm, StockCheckForm, WitnessForm } from "@/components/cd/CdForms";
import { RegisterEntries, StockChecks } from "@/components/cd/Register";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { getShellContext, tenantApi } from "@/lib/api";
import { can } from "@/lib/care-record";
import { isUuid } from "@/lib/context-cookies";
import {
  CD_COUNTER,
  CD_RECORDER,
  CD_WITNESS,
  cdPageHref,
  cdShown,
  cdTabHref,
  movementChip,
} from "@/lib/controlled-drugs";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { getPerson, readOrFail } from "@/lib/person-record";
import { firstParam, recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string; pageId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("controlled-drugs", t("cd.page.title"));
}

const ARRIVALS = new Set([
  "opened",
  "witnessed",
  "recorded",
  "corrected",
  "counted",
  "countedIncident",
]);

/**
 * One register page (MEDS-005; medicines.md section 15 rules 2 to 7): the balance as the API
 * reports it, every entry in order with each correction under the entry it corrects, the counts,
 * and the forms each person may use: signing as witness first (their own session), then recording
 * a movement, a correction or a count with a waiting signature, each after a fresh step-up.
 */
async function RegisterPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id, pageId } = await params;
  if (!isUuid(pageId)) notFound();
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!cdShown(me.permissions)) return <NoAccess />;
  const api = await tenantApi();
  const page = readOrFail(
    await api.GET("/v1/controlled-drugs/pages/{pageId}", { params: { path: { pageId } } }),
    cdTabHref(id),
  );
  if (!page) return <NoAccess />;
  if (page.personId !== id) notFound();
  const recorder = can(me.permissions, CD_RECORDER);
  const counter = recorder || can(me.permissions, CD_COUNTER);
  const witness = can(me.permissions, CD_WITNESS);
  const [recorders, waiting] = await Promise.all([
    witness
      ? api.GET("/v1/controlled-drugs/pages/{pageId}/recorders", { params: { path: { pageId } } })
      : null,
    counter
      ? api.GET("/v1/controlled-drugs/pages/{pageId}/witness-assertions", {
          params: { path: { pageId } },
        })
      : null,
  ]);
  const signatures = waiting?.data?.assertions ?? [];
  const loneAllowed = page.witnessPolicy === "where_available";
  const unit = page.unit.name;
  const query = await searchParams;
  const done = firstParam(query.done);
  const until = formatDateTime(firstParam(query.until) ?? null) ?? "";
  const entryOptions = page.entries.map((e) => ({
    id: e.id,
    label: t("cd.correct.entryOption", {
      seq: e.seq,
      movement: movementChip(e.movement, t).label,
      quantity: e.quantity,
      unit,
      when: formatDateTime(e.occurredAt) ?? "",
    }),
  }));

  return (
    <>
      {done && ARRIVALS.has(done) ? (
        <RecordedArrival message={t("cd.done", { done, until })} param="done" />
      ) : null}
      <Card as="section" title={page.productName} headingLevel={2}>
        <div className="flex flex-col gap-3">
          <p className="m-0 text-title">{t("cd.balance", { balance: page.balance, unit })}</p>
          <p className="m-0 text-body-dense">{t("cd.page.balanceFromApi")}</p>
          <p className="m-0 text-body-dense">
            {t("cd.page.policy", { policy: page.witnessPolicy })}
          </p>
          <div>
            <ButtonLink
              href={`${cdPageHref(id, pageId)}/print`}
              variant="secondary"
              icon={<Printer size={18} strokeWidth={1.5} aria-hidden="true" />}
            >
              {t("cd.print.open")}
            </ButtonLink>
          </div>
        </div>
      </Card>
      <Card as="section" title={t("cd.page.entries")} headingLevel={3}>
        <RegisterEntries page={page} />
      </Card>
      <Card as="section" title={t("cd.page.checks")} headingLevel={3}>
        <StockChecks page={page} />
      </Card>
      {witness ? (
        <Card as="section" title={t("cd.witness.title")} headingLevel={3}>
          {(recorders?.data?.recorders ?? []).length === 0 ? (
            <p className="m-0">{t("cd.witness.noRecorders")}</p>
          ) : (
            <WitnessForm
              personId={id}
              pageId={pageId}
              recorders={recorders?.data?.recorders ?? []}
              unit={unit}
            />
          )}
        </Card>
      ) : null}
      {recorder ? (
        <Card as="section" title={t("cd.form.title")} headingLevel={3}>
          <EntryForm
            personId={id}
            pageId={pageId}
            waiting={signatures}
            loneAllowed={loneAllowed}
            unit={unit}
          />
        </Card>
      ) : null}
      {recorder && page.entries.length > 0 ? (
        <Card as="section" title={t("cd.correct.title")} headingLevel={3}>
          <CorrectionForm
            personId={id}
            pageId={pageId}
            entries={entryOptions}
            waiting={signatures}
            loneAllowed={loneAllowed}
            unit={unit}
          />
        </Card>
      ) : null}
      {counter ? (
        <Card as="section" title={t("cd.check.title")} headingLevel={3}>
          <StockCheckForm
            personId={id}
            pageId={pageId}
            waiting={signatures}
            loneAllowed={loneAllowed}
            unit={unit}
          />
        </Card>
      ) : null}
      <p className="m-0">
        <Link href={cdTabHref(id)} className="inline-flex min-h-target items-center underline">
          {t("cd.back")}
        </Link>
      </p>
    </>
  );
}

export default async function CdPage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="controlled-drugs">
      <RegisterPage {...props} />
    </RecordFrame>
  );
}
