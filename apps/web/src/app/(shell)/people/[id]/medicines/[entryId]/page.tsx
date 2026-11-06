import { Card, StatusChip } from "@harbour/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NoAccess } from "@/components/care/NoAccess";
import { RecordFrame } from "@/components/care/RecordFrame";
import { CheckForm, StopForm } from "@/components/medicines/MedicineForms";
import { PersonCheck } from "@/components/medicines/PersonCheck";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { getShellContext, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  entryChip,
  historyNewestFirst,
  type MedicineEntry,
  mayCheck,
  mayStop,
  medicinesHref,
  medicinesShown,
} from "@/lib/medicines";
import { getPerson, readOrFail } from "@/lib/person-record";
import { firstParam, recordMetadata } from "@/lib/record-metadata";

type Params = Promise<{ id: string; entryId: string }>;
const ARRIVALS = new Set(["transcribed", "checked", "stopped"]);
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata(): Promise<Metadata> {
  return recordMetadata("medicines", t("medicines.entry.title"));
}

const who = (id: string, me: string) =>
  t("medicines.field.by", { who: id === me ? "you" : "other" });

function Version({
  entry,
  latest,
  me,
}: {
  readonly entry: MedicineEntry;
  readonly latest: boolean;
  readonly me: string;
}) {
  const chip = entryChip(entry.state, t);
  const when = (iso: string | null) => formatDateTime(iso) ?? "";
  const withdrawn = entry.state === "withdrawn";
  const body = (
    <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1 text-body-dense sm:grid-cols-[max-content_1fr]">
      <dt className="font-semibold">{t("medicines.field.dose")}</dt>
      <dd className="m-0">{entry.directionsInWords}</dd>
      <dt className="font-semibold">{t("medicines.field.route")}</dt>
      <dd className="m-0">{entry.route.name}</dd>
      <dt className="font-semibold">{t("medicines.field.starts")}</dt>
      <dd className="m-0">{when(entry.startsAt)}</dd>
      {entry.stopsAt ? (
        <>
          <dt className="font-semibold">{t("medicines.field.stops")}</dt>
          <dd className="m-0">{when(entry.stopsAt)}</dd>
        </>
      ) : null}
      {entry.reviewOn ? (
        <>
          <dt className="font-semibold">{t("medicines.field.review")}</dt>
          <dd className="m-0">{formatDate(entry.reviewOn)}</dd>
        </>
      ) : null}
      <dt className="font-semibold">{t("medicines.field.prescriber")}</dt>
      <dd className="m-0">{entry.prescriber}</dd>
      {entry.indication ? (
        <>
          <dt className="font-semibold">{t("medicines.field.indication")}</dt>
          <dd className="m-0 whitespace-pre-wrap">{entry.indication}</dd>
        </>
      ) : null}
      {entry.specialInstructions ? (
        <>
          <dt className="font-semibold">{t("medicines.field.instructions")}</dt>
          <dd className="m-0 whitespace-pre-wrap">{entry.specialInstructions}</dd>
        </>
      ) : null}
      <dt className="font-semibold">{t("medicines.field.source")}</dt>
      <dd className="m-0">
        {t("medicines.field.sourceValue", {
          kind: t("medicines.sourceKind", { kind: entry.source.kind }),
          reference: entry.source.reference,
        })}
      </dd>
      <dt className="font-semibold">{t("medicines.field.transcribed")}</dt>
      <dd className="m-0">
        {t("medicines.field.whenBy", {
          when: when(entry.transcribed.at),
          by: who(entry.transcribed.id, me),
        })}
      </dd>
      {entry.secondCheck ? (
        <>
          <dt className="font-semibold">{t("medicines.field.checked")}</dt>
          <dd className="m-0">
            {t("medicines.field.checkValue", {
              outcome: t("medicines.check.outcomeOption", { outcome: entry.secondCheck.outcome }),
              when: when(entry.secondCheck.at),
              by: who(entry.secondCheck.id, me),
            })}
          </dd>
          {entry.secondCheck.difference ? (
            <>
              <dt className="font-semibold">{t("medicines.check.difference")}</dt>
              <dd className="m-0 whitespace-pre-wrap">{entry.secondCheck.difference}</dd>
            </>
          ) : null}
        </>
      ) : null}
      {entry.stop ? (
        <>
          <dt className="font-semibold">{t("medicines.field.stopped")}</dt>
          <dd className="m-0">
            {t("medicines.field.stoppedValue", {
              when: when(entry.stop.effectiveAt),
              reason: entry.stop.reason,
            })}
          </dd>
        </>
      ) : null}
    </dl>
  );
  return (
    <li className="flex flex-col gap-2 border-b border-border pb-4">
      <h4 className="m-0 text-body font-semibold">
        {t("medicines.entry.version", { version: entry.version, latest: String(latest) })}
      </h4>
      <p className="m-0 flex flex-wrap items-center gap-2">
        <StatusChip status={chip.status} label={chip.label} icon={chip.icon} />
        {!withdrawn ? <span className="text-body-dense">{entry.status.words}</span> : null}
      </p>
      {withdrawn ? (
        <>
          <p className="m-0">
            <span className="font-semibold">{t("medicines.field.withdrawn")}</span>{" "}
            {entry.withdrawn?.reason}
          </p>
          <p className="sr-only">{t("medicines.entry.withdrawnKept")}</p>
          <del className="text-text-secondary">{body}</del>
        </>
      ) : (
        body
      )}
    </li>
  );
}

/**
 * One medicine (medicines.md section 13 rules 2, 4 and 5): what the version in force says, the
 * second check by another person, stopping it, and every version newest first, a withdrawn one
 * struck through with its reason. The person and their allergies are beside each form.
 */
async function EntryTab({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id, entryId } = await params;
  if (!isUuid(entryId)) notFound();
  const { person } = await getPerson(id);
  if (!person) return null;
  const { me } = await getShellContext();
  if (!medicinesShown(me.permissions)) return <NoAccess />;
  const api = await tenantApi();
  const history = readOrFail(
    await api.GET("/v1/medicines/{entryId}/history", { params: { path: { entryId } } }),
    medicinesHref(id),
  );
  if (!history) return <NoAccess />;
  const versions = historyNewestFirst(history.versions);
  const entry = versions.find((v) => v.id === entryId) ?? versions[0];
  if (!entry || entry.personId !== id) notFound();
  const done = firstParam((await searchParams).done);
  const latestVersion = versions[0]?.version ?? entry.version;
  const chip = entryChip(entry.state, t);
  const sourceWords = t("medicines.field.sourceValue", {
    kind: t("medicines.sourceKind", { kind: entry.source.kind }),
    reference: entry.source.reference,
  });

  return (
    <>
      {done && ARRIVALS.has(done) ? (
        <RecordedArrival message={t("medicines.entry.done", { done })} param="done" />
      ) : null}
      <Card as="section" title={entry.product.name} headingLevel={2}>
        <div className="flex flex-col gap-3">
          <p className="m-0 flex flex-wrap items-center gap-2">
            <StatusChip status={chip.status} label={chip.label} icon={chip.icon} />
            <span>{entry.status.words}</span>
          </p>
          {entry.status.notice ? <p className="m-0 font-semibold">{entry.status.notice}</p> : null}
          <p className="m-0 text-body-dense">{t("medicines.entry.asTranscribed")}</p>
          <ul className="m-0 list-none p-0">
            <Version entry={entry} latest={entry.version === latestVersion} me={me.tenantUserId} />
          </ul>
        </div>
      </Card>
      {mayCheck(entry, me.tenantUserId, me.permissions) ? (
        <Card as="section" title={t("medicines.check.title")} headingLevel={3}>
          <CheckForm
            personId={id}
            entryId={entry.id}
            source={sourceWords}
            person={<PersonCheck person={person} />}
          />
        </Card>
      ) : entry.state === "not_yet_checked" ? (
        <p className="m-0">{t("medicines.check.notYou")}</p>
      ) : null}
      {mayStop(entry, me.permissions) && entry.version === latestVersion ? (
        <Card as="section" title={t("medicines.stop.title")} headingLevel={3}>
          <StopForm
            personId={id}
            entryId={entry.id}
            version={latestVersion}
            product={entry.product.name}
            person={<PersonCheck person={person} />}
          />
        </Card>
      ) : null}
      <Card as="section" title={t("medicines.entry.history")} headingLevel={3}>
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {versions.map((v) => (
            <Version
              key={v.id}
              entry={v}
              latest={v.version === latestVersion}
              me={me.tenantUserId}
            />
          ))}
        </ul>
      </Card>
      <p className="m-0">
        <Link href={medicinesHref(id)} className="inline-flex min-h-target items-center underline">
          {t("medicines.back")}
        </Link>
      </p>
    </>
  );
}

export default async function EntryPage(props: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { id } = await props.params;
  return (
    <RecordFrame personId={id} tab="medicines">
      <EntryTab {...props} />
    </RecordFrame>
  );
}
