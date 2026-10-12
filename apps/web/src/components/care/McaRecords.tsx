import type {
  CapacityAssessmentItem,
  ConsentDecisionStatus,
  ConsentItem,
  DolsItem,
} from "@harbour/contracts";
import { Card, StatusChip } from "@harbour/ui";
import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleMinus,
  Clock,
  type LucideIcon,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { t } from "@/lib/i18n";
import {
  decisionView,
  dolsChip,
  dolsClock,
  dolsCqcLines,
  dolsHistoryLines,
  dolsReminders,
  dolsTitle,
  legalReviewView,
  type McaChip,
  type McaIcon,
  type McaLine,
} from "@/lib/mca";

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
