import type {
  BestInterestsItem,
  CapacityAssessmentItem,
  ConsentDecisionStatus,
  ConsentItem,
  DolsItem,
  StaffName,
} from "@harbour/contracts";
import { Card, StatusChip } from "@harbour/ui";
import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleMinus,
  Clock,
  History,
  type LucideIcon,
  RefreshCw,
  TriangleAlert,
  UserCheck,
  UserX,
} from "lucide-react";
import Link from "next/link";
import type { EntryChain, EntryLike } from "@/lib/care-record";
import { formatDate, formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  BEST_INTERESTS_ITEMS,
  capacityChip,
  checklistAnswered,
  consentGivenBy,
  consentRecordChip,
  consentRecordState,
  decisionView,
  dolsChip,
  dolsClock,
  dolsCqcLines,
  dolsHistoryLines,
  dolsReminders,
  dolsTitle,
  FUNCTIONAL_ELEMENTS,
  legalReviewView,
  type McaChip,
  type McaIcon,
  type McaLine,
  reviewOverdue,
  staffName,
} from "@/lib/mca";
import { Notice } from "./Notice";

/**
 * The records of the consent, capacity and DoLS tab, as the API returns them (care.md rules 9 to
 * 11; hazards HZ-020 and HZ-026). Statuses are the API's, each an icon and a word; free text the
 * staff wrote is shown as written; nothing here decides validity or capacity.
 */

const ICONS: Record<McaIcon, LucideIcon> = {
  "circle-check": CircleCheck,
  "circle-help": CircleHelp,
  "circle-alert": CircleAlert,
  "circle-minus": CircleMinus,
  ban: Ban,
  clock: Clock,
  "refresh-cw": RefreshCw,
  "triangle-alert": TriangleAlert,
  history: History,
  "user-check": UserCheck,
  "user-x": UserX,
};

function Chip({ chip }: { readonly chip: McaChip }) {
  return <StatusChip status={chip.status} label={chip.label} icon={ICONS[chip.icon]} />;
}

/** A line of words; one about a moment carries it in a `<time>` element. */
function Line({ line, className = "" }: { readonly line: McaLine; readonly className?: string }) {
  return (
    <p className={`m-0 ${className}`}>
      {line.dateTime ? <time dateTime={line.dateTime}>{line.text}</time> : line.text}
    </p>
  );
}

/** Labelled values; empty ones are left out. Long references wrap rather than overflow. */
function Fields({ rows }: { readonly rows: readonly (readonly [string, string | null])[] }) {
  const shown = rows.filter(([, value]) => Boolean(value));
  if (shown.length === 0) return null;
  return (
    <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2">
      {shown.map(([field, value]) => (
        <div key={field} className="min-w-0">
          <dt className="text-body-dense font-semibold">{t("care.mca.field", { field })}</dt>
          <dd className="m-0 whitespace-pre-line break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const when = (iso: string | null | undefined) => formatDateTime(iso) ?? t("common.notRecorded");

const yesNo = (value: boolean | null | undefined) =>
  value === null || value === undefined ? null : t(value ? "care.common.yes" : "care.common.no");
const decisionList = (decisions: readonly string[] | undefined) =>
  decisions?.length
    ? decisions.map((decision) => t("care.mca.decision", { decision })).join(", ")
    : null;

/** Who recorded it, by name and job title, when the API says. */
function RecordedBy({ staff }: { readonly staff: StaffName | null }) {
  return staff ? (
    <p className="m-0 text-body-dense text-text-secondary">
      {t("care.mca.recordedBy", { name: staffName(staff, t) })}
    </p>
  ) : null;
}

function HistoryLink({ href }: { readonly href: string }) {
  return (
    <p className="m-0 text-body-dense">
      <Link href={href}>{t("care.mca.historyLink")}</Link>
    </p>
  );
}

/**
 * A corrected record (care.md rule 4): why it was corrected, and the earlier versions struck
 * through, one tap away.
 */
function Corrections<
  E extends EntryLike & { readonly recordedAt: string; readonly correctionReason: string | null },
>({ chain, text }: { readonly chain: EntryChain<E>; readonly text: (item: E) => string }) {
  const reason = chain.current.correctionReason;
  return (
    <>
      {chain.current.supersedesId ? (
        <p className="m-0">
          {t("care.mca.corrects", { reason: reason ?? t("common.notRecorded") })}
        </p>
      ) : null}
      {chain.earlier.length > 0 ? (
        <details className="text-body-dense">
          <summary className="inline-flex min-h-target cursor-pointer items-center text-link">
            {t("care.timeline.earlier", { count: chain.earlier.length })}
          </summary>
          <ol className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
            {chain.earlier.map((version) => (
              <li key={version.id} className="rounded-input border border-border px-4 py-2">
                <p className="m-0 text-text-secondary">
                  {t("care.timeline.earlierVersion", { dateTime: when(version.recordedAt) })}
                </p>
                <del className="text-text-secondary">{text(version)}</del>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </>
  );
}

function ReviewOverdue() {
  return <StatusChip status="overdue" label={t("care.mca.reviewOverdue")} icon={Clock} />;
}

/** Whether a valid consent exists now for each decision, and the capacity found for it. */
export function ConsentDecisions({
  decisions,
  records,
  assessments,
  personName,
}: {
  readonly decisions: readonly ConsentDecisionStatus[];
  readonly records: readonly ConsentItem[];
  readonly assessments: readonly CapacityAssessmentItem[];
  readonly personName: string;
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {decisions.map((decision) => {
        const view = decisionView(decision, records, assessments, personName, t);
        return (
          <li
            key={decision.decision}
            className="flex flex-col gap-1 border-b border-border pb-3"
            data-consent-decision={decision.decision}
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">
                {t("care.mca.decision", { decision: decision.decision })}
              </span>
              <Chip chip={view.chip} />
              {view.reviewOverdue ? (
                <StatusChip
                  status="overdue"
                  label={t("care.mca.consent.capacityReviewOverdue")}
                  icon={Clock}
                />
              ) : null}
            </span>
            {view.reason ? <span className="text-body-dense">{view.reason}</span> : null}
            <span className="text-body-dense text-text-secondary">{view.capacity}</span>
            {view.review ? (
              <span className="text-body-dense text-text-secondary">{view.review}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** One DoLS request or authorisation: its status, clock, reminders and CQC notification (HZ-020). */
export function DolsCard({
  item,
  renewed,
  personId,
}: {
  readonly item: DolsItem;
  readonly renewed: boolean;
  readonly personId: string;
}) {
  const legal = legalReviewView(item, t);
  return (
    <Card as="article" title={dolsTitle(item, t)} headingLevel={4}>
      <div className="flex min-w-0 flex-col gap-2" data-dols={item.status}>
        <p className="m-0 flex flex-wrap items-center gap-2">
          <Chip chip={dolsChip(item.status, renewed, t)} />
          {legal?.chip ? <Chip chip={legal.chip} /> : null}
        </p>
        {dolsClock(item, t).map((clock) => (
          <Line key={clock.text} line={clock} className="font-semibold" />
        ))}
        {legal ? <p className="m-0">{legal.text}</p> : null}
        {dolsHistoryLines(item, t).map((entry) => (
          <Line key={entry.text} line={entry} />
        ))}
        {item.precededByUrgent ? (
          <p className="m-0">{t("care.mca.dols.precededByUrgent")}</p>
        ) : null}
        {dolsReminders(item, t).map((reminder) => (
          <Line key={reminder.text} line={reminder} className="text-body-dense" />
        ))}
        {dolsCqcLines(item, t).map((cqc) => (
          <Line key={cqc.text} line={cqc} />
        ))}
        <Fields
          rows={[
            ["supervisoryBody", item.supervisoryBody],
            ["reference", item.supervisoryBodyReference],
            ["rpr", item.rprName],
            ["conditions", item.conditions],
            ["withdrawalReason", item.withdrawalReason],
            ["endedReason", item.endedReason],
            ["objection", item.objectionEvidence],
          ]}
        />
        <p className="m-0 text-body-dense">
          <Link
            href={`/people/${personId}/history/dols_authorisation/${item.id}`}
            className="inline-flex min-h-target items-center"
          >
            {dolsTitle(item, t, true)}
          </Link>
        </p>
      </div>
    </Card>
  );
}

/** A two-stage capacity assessment as recorded, with the outcome in the Act's words. */
export function CapacityCard({
  chain,
  today,
}: {
  readonly chain: EntryChain<CapacityAssessmentItem>;
  readonly today: string;
}) {
  const item = chain.current;
  const assessor = item.assessorName
    ? item.assessorRole
      ? t("care.mca.nameAndRole", { name: item.assessorName, role: item.assessorRole })
      : item.assessorName
    : null;
  // Stage 2 as answered, in the Act's order (none when stage 1 was not met).
  const stage2 = FUNCTIONAL_ELEMENTS.flatMap((element) => {
    const answer = item.stage2[element];
    return answer ? [[element, answer] as const] : [];
  });
  return (
    <Card as="article" title={item.decision} headingLevel={4}>
      <div className="flex flex-col gap-2" data-capacity={item.outcome}>
        <p className="m-0 flex flex-wrap items-center gap-2">
          <Chip chip={capacityChip(item.outcome, t)} />
          {reviewOverdue(item.reviewOn, today) ? <ReviewOverdue /> : null}
        </p>
        <p className="m-0">
          {t("care.mca.capacity.assessed", {
            dateTime: when(item.assessedAt),
            named: assessor ? "yes" : "no",
            assessor: assessor ?? "",
          })}
        </p>
        {item.decisionKind ? (
          <p className="m-0 text-body-dense text-text-secondary">
            {t("care.mca.capacity.kind", {
              decision: t("care.mca.decision", { decision: item.decisionKind }),
            })}
          </p>
        ) : null}
        <Fields
          rows={[
            ["reason", item.reason],
            [
              "impairment",
              [yesNo(item.stage1.impairment), item.stage1.description].filter(Boolean).join("\n"),
            ],
            ["because", yesNo(item.inabilityBecauseOfImpairment)],
            [
              "steps",
              item.practicableSteps
                .map(({ step, detail }) => t("care.mca.capacity.step", { step, detail }))
                .join("\n"),
            ],
          ]}
        />
        {stage2.length > 0 ? (
          <dl className="m-0 flex flex-col gap-2">
            {stage2.map(([element, answer]) => (
              <div key={element}>
                <dt className="text-body-dense font-semibold">
                  {t("care.mca.capacity.element", { element })}
                </dt>
                <dd className="m-0 whitespace-pre-line">
                  {[t("care.mca.capacity.able", { able: String(answer.able) }), answer.evidence]
                    .filter(Boolean)
                    .join("\n")}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {item.reviewOn ? (
          <p className="m-0">{t("care.mca.reviewBy", { date: formatDate(item.reviewOn) ?? "" })}</p>
        ) : null}
        <Corrections
          chain={chain}
          text={(version) =>
            `${version.decision}: ${t("care.mca.capacity.outcome", { outcome: version.outcome })}`
          }
        />
        <RecordedBy staff={item.recordedByStaff} />
      </div>
    </Card>
  );
}

/** A best-interests decision: the checklist, who was consulted and the IMCA prompt (rule 10). */
export function BestInterestsCard({
  chain,
  assessments,
  today,
}: {
  readonly chain: EntryChain<BestInterestsItem>;
  readonly assessments: readonly CapacityAssessmentItem[];
  readonly today: string;
}) {
  const item = chain.current;
  const assessment = assessments.find((a) => a.id === item.capacityAssessmentId);
  return (
    <Card as="article" title={item.decision} headingLevel={4}>
      <div className="flex flex-col gap-2" data-best-interests="">
        {reviewOverdue(item.reviewOn, today) ? (
          <p className="m-0">
            <ReviewOverdue />
          </p>
        ) : null}
        <p className="m-0">{t("care.mca.bi.decided", { dateTime: when(item.decidedAt) })}</p>
        {assessment ? (
          <p className="m-0 text-body-dense text-text-secondary">
            {t("care.mca.bi.follows", {
              dateTime: when(assessment.assessedAt),
              decision: assessment.decision,
            })}
          </p>
        ) : null}
        {item.imcaPrompt ? (
          <Notice
            tone="warning"
            icon={<CircleAlert size={20} strokeWidth={1.5} />}
            title={t("care.mca.bi.imca")}
          >
            {item.imcaPrompt}
          </Notice>
        ) : null}
        {item.seriousMedicalTreatment ? (
          <p className="m-0">{t("care.mca.bi.about", { kind: "smt" })}</p>
        ) : null}
        {item.accommodationChange ? (
          <p className="m-0">{t("care.mca.bi.about", { kind: "accommodation" })}</p>
        ) : null}
        <Fields
          rows={[
            [
              "consulted",
              item.consultations
                .map((c) =>
                  t("care.mca.bi.consultation", {
                    named: c.name ? "yes" : "no",
                    name: c.name ?? "",
                    kind: t("care.mca.bi.consultee", { kind: c.consultee }),
                    dateTime: when(c.consultedAt),
                    views: c.views,
                  }),
                )
                .join("\n"),
            ],
            ["noConsultation", item.noConsultationReason],
          ]}
        />
        <details className="text-body-dense">
          <summary className="inline-flex min-h-target cursor-pointer items-center text-link">
            {t("care.mca.bi.checklist", {
              answered: checklistAnswered(item),
              total: BEST_INTERESTS_ITEMS.length,
            })}
          </summary>
          <dl className="m-0 mt-2 flex flex-col gap-2">
            {BEST_INTERESTS_ITEMS.map((key) => {
              const answer = item.checklist[key];
              return (
                <div key={key}>
                  <dt className="font-semibold">{t("care.mca.bi.item", { item: key })}</dt>
                  <dd className="m-0 whitespace-pre-line">
                    {t("care.mca.bi.answer", {
                      answer: answer?.answer ?? "none",
                      text: answer ? ("note" in answer ? answer.note : answer.reason) : "",
                    })}
                  </dd>
                </div>
              );
            })}
          </dl>
        </details>
        <p className="m-0">{t("care.mca.reviewBy", { date: formatDate(item.reviewOn) ?? "" })}</p>
        <Corrections chain={chain} text={(version) => version.decision} />
        <RecordedBy staff={item.recordedByStaff} />
      </div>
    </Card>
  );
}

/** One consent or refusal: whether it decides its decision now, who gave it and on what authority. */
export function ConsentCard({
  item,
  decisions,
  bestInterests,
  personId,
  personName,
}: {
  readonly item: ConsentItem;
  readonly decisions: readonly ConsentDecisionStatus[];
  readonly bestInterests: readonly BestInterestsItem[];
  readonly personId: string;
  readonly personName: string;
}) {
  const state = consentRecordState(item, decisions);
  const rep = item.representative;
  const decided = bestInterests.find((bi) => bi.id === item.bestInterestsDecisionId);
  const conditions = item.restraintConditions;
  return (
    <Card as="article" title={t("care.mca.decision", { decision: item.decision })} headingLevel={4}>
      <div className="flex flex-col gap-2" data-consent-record={state}>
        <p className="m-0 flex flex-wrap items-center gap-2">
          <Chip chip={consentRecordChip(state, t)} />
        </p>
        <p className="m-0">
          {t("care.mca.consent.made", {
            outcome: item.outcome,
            dateTime: when(item.givenAt),
            who: consentGivenBy(item, personName, t),
          })}
        </p>
        <p className="m-0 text-body-dense text-text-secondary">
          {t("care.mca.consent.capacityThen", { status: item.capacityStatus })}
        </p>
        {item.expiresAt ? (
          <p className="m-0">
            {t("care.mca.consent.expires", {
              expired: state === "expired" ? "yes" : "no",
              dateTime: when(item.expiresAt),
            })}
          </p>
        ) : null}
        {item.withdrawnAt ? (
          <p className="m-0">
            {t("care.mca.consent.withdrawn", {
              dateTime: when(item.withdrawnAt),
              reason: item.withdrawnReason ?? t("common.notRecorded"),
            })}
          </p>
        ) : null}
        <Fields
          rows={[
            ["evidence", item.evidence],
            ["lpa", yesNo(rep?.registered)],
            ["opg", rep?.opgReference ?? null],
            ["excluded", decisionList(rep?.excludedDecisions)],
            [
              "deputyScope",
              rep?.deputyScope ? t("care.mca.deputyScope", { scope: rep.deputyScope }) : null,
            ],
            ["deputyDecisions", decisionList(rep?.deputyDecisions)],
            ["restraint", yesNo(rep?.restraintExpresslyAuthorised)],
            ["orderEnds", rep?.orderEndsAt ? when(rep.orderEndsAt) : null],
            ["court", rep?.courtReference ?? null],
            ["necessary", yesNo(conditions?.necessaryToPreventHarm)],
            ["proportionate", yesNo(conditions?.proportionate)],
            [
              "bestInterests",
              decided
                ? t("care.mca.bi.decidedOn", {
                    dateTime: when(decided.decidedAt),
                    decision: decided.decision,
                  })
                : item.bestInterestsDecisionId
                  ? t("common.notRecorded")
                  : null,
            ],
          ]}
        />
        <RecordedBy staff={item.recordedByStaff} />
        <HistoryLink href={`/people/${personId}/history/consent_record/${item.id}`} />
      </div>
    </Card>
  );
}
