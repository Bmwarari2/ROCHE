import type { CandourItem, IncidentDetail } from "@harbour/contracts";
import { Card } from "@harbour/ui";
import { CircleAlert, Info } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Notice } from "@/components/care/Notice";
import { tenantApi } from "@/lib/api";
import {
  type CandourDocument,
  candourClocks,
  candourDocuments,
  candourFinding,
  candourForms,
  candourManageable,
  candourShown,
  candourStateChip,
  candourSteps,
  harbourFinding,
} from "@/lib/candour";
import { can, tabHref } from "@/lib/care-record";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { ukToday } from "@/lib/uk-time";
import { CandourForms, type DocumentChoice } from "./CandourForms";
import { SafetyWarning, When } from "./IncidentNotifications";
import { PersonNeeds, type PersonNeedsOf } from "./PersonNeeds";
import { SafetyChip } from "./SafetyChip";

const iconProps = { size: 20, strokeWidth: 1.5, "aria-hidden": true } as const;
const link = "inline-flex min-h-target items-center underline";

/** One labelled value of the record, in a description list. */
function Detail({ field, children }: { readonly field: string; readonly children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-body-dense font-semibold">{t("safety.candour.field", { field })}</dt>
      <dd className="m-0 whitespace-pre-line break-words">{children}</dd>
    </div>
  );
}

/** A moment in a `<time>` element, in UK time. */
function At({ iso }: { readonly iso: string | null }) {
  const words = formatDateTime(iso);
  return iso && words ? <time dateTime={iso}>{words}</time> : null;
}

/** A kept document: linked when the reader's list names it, else said to be kept. */
function DocumentLink({
  id,
  documents,
}: {
  readonly id: string;
  readonly documents: ReadonlyMap<string, CandourDocument>;
}) {
  const known = documents.get(id);
  return known ? (
    <a href={`/documents/${id}`} className={link}>
      {t("safety.candour.download", { label: known.label })}
    </a>
  ) : (
    <span>{t("safety.candour.documentKept")}</span>
  );
}

/** What was given or included, each said in words (never a tick alone). */
function Given({
  items,
}: {
  readonly items: readonly { readonly item: string; readonly given: boolean }[];
}) {
  return (
    <ul className="m-0 flex list-disc flex-col gap-1 ps-5">
      {items.map(({ item, given }) => (
        <li key={item}>{t("safety.candour.given", { item, given: String(given) })}</li>
      ))}
    </ul>
  );
}

/**
 * The duty of candour on an incident (regulation 20; safety.md section 4 rule 5; SAFE-007; hazards
 * HZ-013 and HZ-091): where the record stands, its clocks in words and icons (telling the person
 * as soon as reasonably practicable; the written notification against the organisation's target
 * from the rate table, never called a legal deadline), what was recorded and, for a manager, the
 * forms for its stage and its next steps, each offered only when the API would take it. With no
 * record yet it says whether Harbour found the duty may apply.
 */
export async function CandourSection({
  incident,
  record,
  unknown = false,
  viewer,
  names,
  records,
  now,
}: {
  readonly incident: IncidentDetail;
  readonly record: CandourItem | null;
  /** The candour record could not be read: say so, offer nothing (review M3). */
  readonly unknown?: boolean;
  readonly viewer: { readonly tenantUserId: string; readonly permissions: readonly string[] };
  /** The people we support, by id, in the reader's words. */
  readonly names: ReadonlyMap<string, string>;
  /** The people we support from the reader's own list, for their communication needs (AIS). */
  readonly records: ReadonlyMap<string, PersonNeedsOf>;
  readonly now: Date;
}) {
  if (!candourShown(incident, record) && !unknown) return null;
  if (unknown) {
    return (
      <Card as="section" aria-labelledby="candour">
        <div className="flex flex-col gap-4 break-words">
          <h2 id="candour" tabIndex={-1} className="hb-card__title scroll-mt-nav">
            {t("safety.candour.title")}
          </h2>
          <Notice
            tone="warning"
            icon={<CircleAlert {...iconProps} />}
            title={t("safety.candour.unknown")}
          >
            {t("safety.candour.unknownHint")}
          </Notice>
        </div>
      </Card>
    );
  }
  const manage = candourManageable(incident, viewer.permissions);
  const api = await tenantApi();
  // The organisation's target for the written notification, from the rate table on the
  // incident's date (ADR-0021), never a literal.
  const rate =
    record && record.threshold?.notifiable !== false
      ? await api.GET("/v1/rates/{key}", {
          params: {
            path: { key: "candour.written_notification.working_days" },
            query: { on: ukToday(new Date(incident.occurredAt)) },
          },
        })
      : null;
  const clocks = record ? candourClocks(record, now, t, rate?.data?.value) : null;
  const personId = record?.personId ?? null;
  const needs = personId ? records.get(personId) : undefined;
  const personName = personId
    ? (names.get(personId) ?? t("safety.incident.unnamed", { kind: "service_user" }))
    : null;
  // The relevant person's documents (an audited read), to choose from and to link what is kept.
  const hasDocuments = Boolean(
    record &&
      (record.verbal?.writtenRecordId ||
        record.written?.documentId ||
        record.correspondenceDocumentIds.length > 0),
  );
  const readsDocuments = can(viewer.permissions, "people.person.read");
  const listed =
    personId && readsDocuments && (manage || hasDocuments)
      ? await api.GET("/v1/documents", { params: { query: { personId } } })
      : null;
  const offered = candourDocuments(listed?.data?.items ?? [], t);
  const byId = new Map(offered.map((d) => [d.id, d]));
  const documents: DocumentChoice = {
    offered,
    empty: !personId ? "noPerson" : !listed?.data ? "hidden" : offered.length === 0 ? "none" : null,
    name: personName,
    lettersHref:
      personId && can(viewer.permissions, "comms.letter.manage")
        ? tabHref(personId, "letters")
        : null,
  };
  const people = incident.people
    .filter((p) => p.kind === "service_user" && p.personId)
    .map((p) => ({
      value: p.personId as string,
      label: names.get(p.personId as string) ?? t("safety.incident.unnamed", { kind: p.kind }),
    }));
  const finding = candourFinding(incident.classifier);
  const forms = manage ? candourForms(record?.state ?? null) : [];
  // A candour notification Harbour drafted makes "not notifiable" need a sentence and a tick.
  const drafted = (incident.classifier?.notifications ?? []).some((n) => n.kind === "candour");
  const steps = manage ? candourSteps(record, viewer, t, drafted) : [];
  // The threshold question repeats regulation 20(9), its prolonged period from the rate table on
  // the incident's date (`candour.prolonged_harm_days`), never a literal (review M4).
  const prolonged = forms.includes("threshold")
    ? await api.GET("/v1/rates/{key}", {
        params: {
          path: { key: "candour.prolonged_harm_days" },
          query: { on: ukToday(new Date(incident.occurredAt)) },
        },
      })
    : null;
  const closedWithout = incident.status === "closed" && !record;

  return (
    <Card as="section" aria-labelledby="candour">
      <div className="flex flex-col gap-4 break-words">
        {/* Focusable, so the "finish the duty of candour record" link brings focus here. */}
        <h2 id="candour" tabIndex={-1} className="hb-card__title scroll-mt-nav">
          {t("safety.candour.title")}
        </h2>
        <p className="m-0 max-w-prose text-body-dense text-text-secondary">
          {t("safety.candour.intro")}
        </p>
        {record ? (
          <>
            <p className="m-0 flex flex-wrap items-center gap-2">
              <SafetyChip chip={candourStateChip(record.state, t)} />
            </p>
            {clocks ? (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {clocks.clocks.map((clock) => (
                  <li key={clock.line.text} className="flex flex-wrap items-center gap-2">
                    <SafetyChip chip={clock.chip} />
                    <When line={clock.line} />
                  </li>
                ))}
              </ul>
            ) : null}
            {clocks?.provisional ? <SafetyWarning text={t("safety.candour.provisional")} /> : null}
            <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Detail field="person">
                {personName ?? t("common.notRecorded")}
                {/* Telling them in person needs their communication needs (AIS). */}
                {needs ? <PersonNeeds person={needs} /> : null}
              </Detail>
              <Detail field="threshold">
                {record.threshold ? (
                  <>
                    {t("safety.candour.threshold", {
                      notifiable: String(record.threshold.notifiable),
                    })}{" "}
                    <At iso={record.threshold.decidedAt} />
                  </>
                ) : (
                  t("common.notRecorded")
                )}
              </Detail>
              {record.threshold ? (
                <Detail field="decidedBy">{record.threshold.decidedBy}</Detail>
              ) : null}
              {record.verbal ? (
                <>
                  <Detail field="verbal">
                    <At iso={record.verbal.at} />
                    {", "}
                    {t("safety.candour.inPerson", { inPerson: String(record.verbal.inPerson) })}
                  </Detail>
                  <Detail field="verbalBy">{record.verbal.byRepresentatives.join("\n")}</Detail>
                  <Detail field="verbalContents">
                    <Given
                      items={[
                        { item: "account", given: record.verbal.accountGiven },
                        { item: "enquiriesAdvised", given: record.verbal.enquiriesAdvised },
                        { item: "apology", given: record.verbal.apologyGiven },
                      ]}
                    />
                  </Detail>
                  <Detail field="writtenRecord">
                    {record.verbal.writtenRecordId ? (
                      <DocumentLink id={record.verbal.writtenRecordId} documents={byId} />
                    ) : (
                      t("common.notRecorded")
                    )}
                  </Detail>
                </>
              ) : null}
              {record.contactAttempts.length > 0 ? (
                <Detail field="attempts">
                  <ul className="m-0 flex list-disc flex-col gap-1 ps-5">
                    {record.contactAttempts.map((attempt) => (
                      <li key={`${attempt.at} ${attempt.note}`}>
                        <At iso={attempt.at} />
                        {": "}
                        {attempt.note}
                      </li>
                    ))}
                  </ul>
                </Detail>
              ) : null}
              {record.written ? (
                <>
                  <Detail field="written">
                    <At iso={record.written.sentAt} />
                  </Detail>
                  <Detail field="writtenContents">
                    <Given
                      items={[
                        { item: "account", given: record.written.includesAccount },
                        { item: "enquiries", given: record.written.includesEnquiries },
                        { item: "apology", given: record.written.includesApology },
                      ]}
                    />
                  </Detail>
                  <Detail field="writtenCopy">
                    {record.written.documentId ? (
                      <DocumentLink id={record.written.documentId} documents={byId} />
                    ) : (
                      t("common.notRecorded")
                    )}
                  </Detail>
                  <Detail field="resultsShared">
                    {record.enquiryResultsSharedAt ? (
                      <At iso={record.enquiryResultsSharedAt} />
                    ) : (
                      t("safety.candour.notYet")
                    )}
                  </Detail>
                </>
              ) : null}
              {record.correspondenceDocumentIds.length > 0 ? (
                <Detail field="correspondence">
                  <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    {record.correspondenceDocumentIds.map((id) => (
                      <li key={id}>
                        <DocumentLink id={id} documents={byId} />
                      </li>
                    ))}
                  </ul>
                </Detail>
              ) : null}
              {record.outcome ? <Detail field="outcome">{record.outcome}</Detail> : null}
            </dl>
          </>
        ) : closedWithout ? (
          // Closed before closing waited for the candour record (review H2): said plainly, never
          // as something to record here (a closed incident takes no candour forms).
          <Notice
            tone={finding === "none" ? "info" : "warning"}
            icon={finding === "none" ? <Info {...iconProps} /> : <CircleAlert {...iconProps} />}
            title={t("safety.candour.closedWithout", { finding })}
          >
            {t("safety.candour.closedWithoutHint", { finding })}
          </Notice>
        ) : finding === "found" ? (
          <Notice
            tone="warning"
            icon={<CircleAlert {...iconProps} />}
            title={t("safety.candour.none", { finding })}
          >
            {t("safety.candour.noneHint", { finding, manage: String(manage) })}
          </Notice>
        ) : (
          <Notice icon={<Info {...iconProps} />} title={t("safety.candour.none", { finding })}>
            {t("safety.candour.noneHint", { finding, manage: String(manage) })}
          </Notice>
        )}
        {manage && (forms.length > 0 || steps.length > 0) ? (
          <CandourForms
            incidentId={incident.id}
            record={record}
            forms={forms}
            steps={steps}
            people={people}
            documents={documents}
            finding={harbourFinding(incident.classifier, record)}
            {...(prolonged?.data ? { prolongedDays: prolonged.data.value } : {})}
          />
        ) : null}
        {personId && names.has(personId) && can(viewer.permissions, "people.person.read") ? (
          <p className="m-0 text-body-dense">
            <Link href={tabHref(personId, "overview")} className={link}>
              {t("safety.candour.personLink", { name: personName ?? "" })}
            </Link>
          </p>
        ) : null}
      </div>
    </Card>
  );
}
