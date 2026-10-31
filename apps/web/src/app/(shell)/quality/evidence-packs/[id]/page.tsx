import type { EvidencePackDetail } from "@harbour/contracts";
import { ukEndOfDay, ukStartOfDay } from "@harbour/domain";
import { Card, PageHeader } from "@harbour/ui";
import { CircleAlert, Info, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Notice } from "@/components/care/Notice";
import { PackEndForms } from "@/components/quality/PackEndForms";
import {
  AddRecordsForm,
  LinkIssuer,
  type RecordCandidate,
  RedactForm,
} from "@/components/quality/PackForms";
import { QualityChip } from "@/components/quality/QualityChip";
import { PersonNeeds } from "@/components/safety/PersonNeeds";
import { RecordedArrival } from "@/components/safety/RecordedArrival";
import { SafetyForbidden } from "@/components/safety/SafetyChip";
import { getShellContext, problemCode, tenantApi } from "@/lib/api";
import { isUuid } from "@/lib/context-cookies";
import {
  evidencePacksShown,
  expiryChoices,
  expiryWords,
  fieldOutcomeChip,
  isKeyQuestion,
  keyQuestionLabel,
  latestLink,
  linkState,
  linkStateChip,
  packActions,
  packRangeQuery,
  packStateChip,
  redactable,
  shareCounts,
} from "@/lib/evidence-packs";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { incidentTitle } from "@/lib/incidents";
import { readOrFail } from "@/lib/person-record";
import { qualityDone } from "@/lib/quality-done";
import { getPackPeople, webOrigin } from "@/lib/quality-server";

type Params = Promise<{ id: string }>;
type Search = Promise<{
  done?: string | string[];
  person?: string | string[];
  redact?: string | string[];
}>;

/** The page title says what it is, never who it is for. */
export const metadata: Metadata = { title: t("quality.pack.pageTitle") };

const link = "inline-flex min-h-target items-center underline";
const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : null);
const range = { start: ukStartOfDay, end: ukEndOfDay };

/** Labelled values in a list; a value may be any node. */
function Fields({ rows }: { readonly rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2">
      {rows.map(([field, value]) => (
        <div key={field} className="min-w-0">
          <dt className="text-body-dense font-semibold">{field}</dt>
          <dd className="m-0 whitespace-pre-line break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A key question's name, or the id as stored when it is not one Harbour offers yet. */
const statementName = (id: string) => (isKeyQuestion(id) ? keyQuestionLabel(id, t) : id);

/** The rate table's figure for a pack policy key, or null when it cannot be read. */
async function rate(key: string): Promise<number | null> {
  const api = await tenantApi();
  const { data } = await api.GET("/v1/rates/{key}", { params: { path: { key } } });
  return typeof data?.value === "number" ? data.value : null;
}

/** One person's records in the pack's dates that the web can offer: notes, readings, incidents. */
async function candidatesFor(
  pack: EvidencePackDetail,
  personId: string,
): Promise<RecordCandidate[]> {
  const api = await tenantApi();
  const query = packRangeQuery(pack, range);
  const [notes, observations, incidents] = await Promise.all([
    api.GET("/v1/people/{id}/notes", { params: { path: { id: personId }, query } }),
    api.GET("/v1/people/{id}/observations", { params: { path: { id: personId }, query } }),
    api.GET("/v1/incidents", { params: { query: { ...query, personId } } }),
  ]);
  const inPack = new Set(pack.items.map((i) => `${i.recordType}:${i.recordId}`));
  const rows: (RecordCandidate & { readonly at: string })[] = [
    ...(notes.data?.items ?? [])
      .filter((n) => !n.superseded)
      .map((n) => ({
        key: `care_note:${n.id}`,
        title: t("quality.records.note", { category: n.category }),
        when: formatDateTime(n.occurredAt) ?? "",
        at: n.occurredAt,
        inPack: inPack.has(`care_note:${n.id}`),
      })),
    ...(observations.data?.items ?? [])
      .filter((o) => !o.superseded)
      .map((o) => ({
        key: `observation:${o.id}`,
        title: t("quality.records.observation", { chart: o.chart }),
        when: formatDateTime(o.occurredAt) ?? "",
        at: o.occurredAt,
        inPack: inPack.has(`observation:${o.id}`),
      })),
    ...(incidents.data?.items ?? [])
      .filter((i) => !i.restricted)
      .map((i) => ({
        key: `incident:${i.id}`,
        title: incidentTitle(i, t),
        when: formatDateTime(i.occurredAt) ?? "",
        at: i.occurredAt,
        inPack: inPack.has(`incident:${i.id}`),
      })),
  ];
  return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).map(({ at: _, ...row }) => row);
}

/**
 * The original text of a withheld free-text field, as the composer can already read it, to edit
 * into the redacted copy: an incident's description or immediate actions, read once by its id.
 * Empty otherwise (a care note would mean reading every person's notes to find it, beyond need,
 * DPIA R13): the composer opens the record to read it.
 */
async function originalText(
  item: EvidencePackDetail["items"][number],
  key: string,
): Promise<string> {
  const api = await tenantApi();
  if (item.recordType === "incident" && (key === "description" || key === "immediate_actions")) {
    const { data } = await api.GET("/v1/incidents/{id}", {
      params: { path: { id: item.recordId } },
    });
    if (!data) return "";
    return (key === "description" ? data.description : data.immediateActions) ?? "";
  }
  return "";
}

/**
 * One evidence pack (QUAL-003; quality.md section 16; HZ-050; ADR-0050). What will be shared comes
 * first, in full, so the releaser reads exactly what leaves the provider: the recipient and their
 * address, the purpose, dates, locations, the people in scope by name, staff names, the watermark,
 * and every record with each field's outcome as an icon and a word and the reason in words. Then
 * the records left out (internal only), the links with their expiry in words, and the actions the
 * API allows this person: add records, redact by hand, release or issue a new link (step-up, never
 * by anyone who shaped the pack), revoke, discard.
 */
export default async function EvidencePackPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: Search;
}) {
  const { id } = await params;
  const query = await searchParams;
  if (!isUuid(id)) notFound();
  const { me } = await getShellContext();
  const listTitle = t("quality.packs.title");
  if (!evidencePacksShown(me.permissions)) return <SafetyForbidden title={listTitle} />;
  const api = await tenantApi();
  const result = await api.GET("/v1/evidence-packs/{id}", { params: { path: { id } } });
  if (problemCode(result.error) === "not_found") notFound();
  const pack = readOrFail(result, `/quality/evidence-packs/${id}`);
  if (!pack) return <SafetyForbidden title={listTitle} />;

  const now = new Date();
  const path = `/quality/evidence-packs/${id}`;
  const done = qualityDone(query.done);
  const actions = packActions(pack, me, now);
  const counts = shareCounts(pack);
  const people = await getPackPeople();
  const personName = (personId: string) =>
    people.get(personId)?.name ?? t("quality.pack.personHidden");
  const locationNames = pack.locationIds.map(
    (l) => me.locations.find((x) => x.id === l)?.name ?? t("quality.pack.locationHidden"),
  );
  const title = t("quality.packs.itemTitle", {
    name: pack.recipientName,
    organisation: pack.recipientOrganisation,
  });
  const latest = latestLink(pack);

  // Adding records: one person in scope at a time.
  const person = one(query.person);
  const chosen = actions.addRecords && person && pack.personIds.includes(person) ? person : null;
  const candidates = chosen ? await candidatesFor(pack, chosen) : [];

  // Redacting by hand: one field at a time, with its original to edit.
  const [redactItem, redactKey] = (one(query.redact) ?? "").split(":");
  const target =
    actions.redact && redactItem && redactKey
      ? pack.items.find((i) => i.id === redactItem && i.exclusionReason === null)
      : undefined;
  const targetField = target?.fields.find((f) => f.key === redactKey && redactable(f));
  const original = target && targetField ? await originalText(target, targetField.key) : "";

  // Release and a new link: how long the link may work, from the rate table.
  const issuing = actions.release || actions.reissue;
  const [defaultDays, maxDays] = issuing
    ? await Promise.all([
        rate("evidence_pack.link_expiry_days.default"),
        rate("evidence_pack.link_expiry_days.max"),
      ])
    : [null, null];
  const choices =
    defaultDays !== null && maxDays !== null ? expiryChoices(defaultDays, maxDays) : [];
  const origin = webOrigin();

  const included = pack.items.filter((i) => i.exclusionReason === null);
  const excluded = pack.items.filter((i) => i.exclusionReason !== null);

  return (
    <div className="mx-auto flex w-full max-w-content flex-col gap-6 break-words">
      <nav aria-label={t("common.breadcrumb")} className="text-body-dense">
        <Link href="/quality/evidence-packs" className={link}>
          {listTitle}
        </Link>
        <span aria-hidden="true" className="px-2 text-text-secondary">
          ›
        </span>
        <span aria-current="page">{title}</span>
      </nav>
      <PageHeader eyebrow={t("quality.pack.eyebrow")} title={title} description={pack.purpose} />
      {done ? <RecordedArrival message={t("quality.done", { done })} param="done" /> : null}
      <p className="m-0 flex flex-wrap items-center gap-2">
        <QualityChip chip={packStateChip(pack.state, t)} />
      </p>

      <Card as="section" title={t("quality.pack.shared")} headingLevel={2}>
        <div className="flex flex-col gap-4">
          <p className="m-0 max-w-prose">{t("quality.pack.sharedIntro")}</p>
          <Fields
            rows={[
              [
                t("quality.pack.field", { field: "recipient" }),
                `${pack.recipientName}, ${pack.recipientOrganisation}`,
              ],
              [t("quality.pack.field", { field: "email" }), pack.recipientEmail],
              [t("quality.pack.field", { field: "purpose" }), pack.purpose],
              [
                t("quality.pack.field", { field: "dates" }),
                t("quality.pack.dates", {
                  from: formatDate(pack.from) ?? "",
                  to: formatDate(pack.to) ?? "",
                }),
              ],
              [t("quality.pack.field", { field: "locations" }), locationNames.join(", ")],
              [
                t("quality.pack.field", { field: "staffNames" }),
                t("quality.staffNames", { mode: pack.staffNames }),
              ],
              [
                t("quality.pack.field", { field: "statements" }),
                pack.qualityStatementIds === null
                  ? t("quality.pack.everyStatement")
                  : pack.qualityStatementIds.map(statementName).join(", "),
              ],
              [
                t("quality.pack.field", { field: "counts" }),
                t("quality.pack.counts", {
                  included: counts.included,
                  withheld: counts.withheld,
                  redacted: counts.redacted,
                }),
              ],
            ]}
          />
          <div className="flex flex-col gap-1">
            <h3 className="m-0 inline-flex items-center gap-2 text-body font-semibold">
              <Users size={18} strokeWidth={1.5} aria-hidden="true" />
              {t("quality.pack.people", { count: pack.personIds.length })}
            </h3>
            <ul className="m-0 flex list-disc flex-col gap-1 ps-5">
              {pack.personIds.map((id) => {
                const person = people.get(id);
                return (
                  <li key={id} className="flex flex-col gap-1">
                    <span>
                      {person
                        ? t("quality.pack.personLine", {
                            name: person.name,
                            born: formatDate(person.dateOfBirth) ?? "",
                            hasBorn: String(person.dateOfBirth !== null),
                          })
                        : t("quality.pack.personHidden")}
                    </span>
                    {person ? <PersonNeeds person={person} /> : null}
                  </li>
                );
              })}
            </ul>
            <p className="m-0 text-body-dense text-text-secondary">
              {t("quality.pack.peopleHint")}
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="m-0 text-body font-semibold">{t("quality.pack.watermark")}</h3>
            <p lang="en-GB" className="m-0 rounded-input bg-bg-secondary p-3">
              {pack.watermark}
            </p>
          </div>
          {pack.bundleDeleted ? (
            <Notice
              icon={<Info size={20} strokeWidth={1.5} aria-hidden="true" />}
              title={t("quality.pack.bundleDeleted")}
            >
              {t("quality.pack.bundleDeletedHint")}
            </Notice>
          ) : null}
          {counts.awaitingRedaction > 0 && pack.state === "draft" ? (
            <Notice
              tone="warning"
              icon={<CircleAlert size={20} strokeWidth={1.5} aria-hidden="true" />}
              title={t("quality.pack.awaiting", { count: counts.awaitingRedaction })}
            >
              {t("quality.pack.awaitingHint")}
            </Notice>
          ) : null}
        </div>
      </Card>

      {/* Always rendered here, so a link just issued stays on screen when the pack refreshes. */}
      <LinkIssuer
        mode={
          origin === null ? null : actions.release ? "release" : actions.reissue ? "reissue" : null
        }
        packId={pack.id}
        linkId={latest?.id ?? null}
        version={actions.reissue && latest ? latest.version : pack.version}
        path={path}
        recipientEmail={pack.recipientEmail}
        origin={origin ?? ""}
        choices={choices}
        defaultDays={defaultDays}
      />
      {pack.state === "draft" &&
      actions.releaseBlock &&
      actions.releaseBlock !== "no_permission" ? (
        <Notice
          icon={<Info size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("quality.release.blockedTitle")}
        >
          {t("quality.release.blocked", { why: actions.releaseBlock })}
        </Notice>
      ) : null}

      <Card
        as="section"
        title={t("quality.pack.records", { count: included.length })}
        headingLevel={2}
      >
        {included.length === 0 ? (
          <p className="m-0">{t("quality.pack.noRecords")}</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-6 p-0">
            {included.map((item) => (
              <li key={item.id} className="flex flex-col gap-2 border-b border-border pb-4">
                <h3 lang="en-GB" className="m-0 text-body font-semibold">
                  {item.title}
                </h3>
                <p className="m-0 text-body-dense text-text-secondary">
                  {t("quality.pack.itemMeta", {
                    when: formatDateTime(item.occurredAt) ?? "",
                    statements: item.qualityStatementIds.map(statementName).join(", "),
                  })}
                </p>
                <dl className="m-0 flex flex-col gap-3">
                  {item.fields.map((field) => (
                    <div key={field.key} className="flex flex-col gap-1">
                      <dt className="flex flex-wrap items-center gap-2">
                        <span lang="en-GB" className="font-semibold">
                          {field.label}
                        </span>
                        <QualityChip chip={fieldOutcomeChip(field.outcome, t)} />
                      </dt>
                      <dd className="m-0 flex flex-col gap-1">
                        {field.value !== null ? (
                          <span className="whitespace-pre-line">{field.value}</span>
                        ) : field.outcome === "included" ? (
                          <span className="text-text-secondary">{t("quality.pack.noValue")}</span>
                        ) : null}
                        {field.reasonText ? (
                          <span lang="en-GB" className="text-body-dense text-text-secondary">
                            {field.reasonText}
                          </span>
                        ) : null}
                        {actions.redact && redactable(field) ? (
                          target?.id === item.id && targetField?.key === field.key ? (
                            <div id="redact-form" className="mt-2">
                              <RedactForm
                                packId={pack.id}
                                itemId={item.id}
                                fieldKey={field.key}
                                label={field.label}
                                original={original}
                                version={pack.version}
                                path={path}
                              />
                            </div>
                          ) : (
                            <Link
                              href={`${path}?redact=${item.id}:${field.key}#redact-form`}
                              className={link}
                              aria-label={t("quality.redact.open", {
                                label: field.label,
                                title: item.title,
                              })}
                            >
                              {t("quality.redact.link")}
                            </Link>
                          )
                        ) : null}
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {actions.addRecords ? (
        <Card as="section" title={t("quality.records.title")} headingLevel={2}>
          <div className="flex flex-col gap-4">
            <p className="m-0 max-w-prose">{t("quality.records.intro")}</p>
            <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0">
              {pack.personIds.map((p) => (
                <li key={p}>
                  <Link
                    href={`${path}?person=${p}#add-title`}
                    className={link}
                    {...(p === chosen ? { "aria-current": "true" as const } : {})}
                  >
                    {t("quality.records.choosePerson", { name: personName(p) })}
                  </Link>
                </li>
              ))}
            </ul>
            {chosen ? (
              <AddRecordsForm
                key={chosen}
                packId={pack.id}
                version={pack.version}
                path={`${path}?person=${chosen}`}
                candidates={candidates}
              />
            ) : null}
          </div>
        </Card>
      ) : null}

      {excluded.length > 0 ? (
        <Card
          as="section"
          title={t("quality.pack.excluded", { count: excluded.length })}
          headingLevel={2}
        >
          <div className="flex flex-col gap-2">
            <p className="m-0 max-w-prose">{t("quality.pack.excludedIntro")}</p>
            <ul className="m-0 flex list-disc flex-col gap-1 ps-5">
              {excluded.map((item) => (
                <li key={item.id}>
                  <span lang="en-GB">{item.title}</span>
                  {t("quality.pack.excludedLine", {
                    when: formatDateTime(item.occurredAt) ?? t("common.notRecorded"),
                    reason: t("quality.pack.exclusion", {
                      reason: item.exclusionReason ?? "other",
                    }),
                  })}
                </li>
              ))}
            </ul>
          </div>
        </Card>
      ) : null}

      {pack.links.length > 0 ? (
        <Card as="section" title={t("quality.pack.links")} headingLevel={2}>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {[...pack.links]
              .sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt))
              .map((l) => {
                const state = linkState(l, now);
                return (
                  <li key={l.id} className="flex flex-col gap-1 border-b border-border pb-3">
                    <span>
                      <QualityChip chip={linkStateChip(state, t)} />
                    </span>
                    <span>
                      {t("quality.link.issued", {
                        when: formatDateTime(l.issuedAt) ?? "",
                        email: pack.recipientEmail,
                      })}
                    </span>
                    <span className="font-semibold">
                      {state === "live" || state === "expired"
                        ? expiryWords(l.expiresAt, formatDateTime(l.expiresAt) ?? "", now, t)
                        : t("quality.link.ended", {
                            state,
                            when: formatDateTime(l.revokedAt) ?? "",
                          })}
                    </span>
                    <span className="text-body-dense text-text-secondary">
                      {t("quality.link.activity", {
                        opened: formatDateTime(l.lastOpenedAt) ?? "",
                        hasOpened: String(l.lastOpenedAt !== null),
                        failed: l.failedCodeAttempts,
                      })}
                    </span>
                  </li>
                );
              })}
          </ul>
        </Card>
      ) : null}

      <PackEndForms
        packId={pack.id}
        version={pack.version}
        path={path}
        revoke={actions.revoke}
        discard={actions.discard}
      />
      {pack.state === "revoked" || pack.state === "discarded" ? (
        <Notice
          icon={<Info size={20} strokeWidth={1.5} aria-hidden="true" />}
          title={t("quality.pack.ended", { state: pack.state })}
        >
          {pack.revocationReason ?? pack.discardReason ?? ""}
        </Notice>
      ) : null}
    </div>
  );
}
