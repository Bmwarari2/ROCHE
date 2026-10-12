import type { ConsentDecisionStatus, DolsItem } from "@harbour/contracts";
import { Card, StatusChip } from "@harbour/ui";
import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleMinus,
  Clock,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  consentChip,
  dolsChip,
  dolsClock,
  dolsCqcLine,
  dolsReminders,
  type McaChip,
  type McaIcon,
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
};

function Chip({ chip }: { readonly chip: McaChip }) {
  return <StatusChip status={chip.status} label={chip.label} icon={ICONS[chip.icon]} />;
}

const when = (iso: string | null | undefined) => formatDateTime(iso) ?? t("common.notRecorded");

/** Labelled values; empty ones are left out. */
function Fields({ rows }: { readonly rows: readonly (readonly [string, string | null])[] }) {
  const shown = rows.filter(([, value]) => Boolean(value));
  if (shown.length === 0) return null;
  return (
    <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2">
      {shown.map(([field, value]) => (
        <div key={field}>
          <dt className="text-body-dense font-semibold">{t("care.mca.field", { field })}</dt>
          <dd className="m-0 whitespace-pre-line">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Whether a valid consent exists now for each decision, and the capacity found for it. */
export function ConsentDecisions({
  decisions,
}: {
  readonly decisions: readonly ConsentDecisionStatus[];
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {decisions.map((decision) => {
        const chip = consentChip(decision, t);
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
              <Chip chip={chip} />
              {decision.capacityReviewOverdue ? (
                <StatusChip
                  status="overdue"
                  label={t("care.mca.consent.capacityReviewOverdue")}
                  icon={Clock}
                />
              ) : null}
            </span>
            <span className="text-body-dense text-text-secondary">
              {t("care.mca.consent.capacityNow", { capacity: decision.capacity })}
            </span>
            {/* Who refused, or why no consent is valid, in the API's words (English only). */}
            {decision.message && (chip.status === "overdue" || decision.status === "refused") ? (
              <span className="text-body-dense">{decision.message}</span>
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
  personId,
}: {
  readonly item: DolsItem;
  readonly personId: string;
}) {
  return (
    <Card as="article" title={t("care.mca.dols.type", { type: item.type })} headingLevel={4}>
      <div className="flex flex-col gap-2" data-dols={item.status}>
        <p className="m-0 flex flex-wrap items-center gap-2">
          <Chip chip={dolsChip(item.status, t)} />
        </p>
        {dolsClock(item, t).map((line) => (
          <p key={line} className="m-0 font-semibold">
            {line}
          </p>
        ))}
        <p className="m-0">
          {t("care.mca.dols.requested", { type: item.type, dateTime: when(item.requestedAt) })}
        </p>
        {item.outcome !== "pending" ? (
          <p className="m-0">
            {t("care.mca.dols.outcome", { outcome: item.outcome, dateTime: when(item.outcomeAt) })}
          </p>
        ) : null}
        {item.precededByUrgent ? (
          <p className="m-0">{t("care.mca.dols.precededByUrgent")}</p>
        ) : null}
        {item.extensions.map((extension) => (
          <p key={extension.requestedAt} className="m-0">
            {t("care.mca.dols.extension", {
              outcome: extension.outcome,
              dateTime: when(extension.requestedAt),
              to: when(extension.extendedTo),
            })}
          </p>
        ))}
        {dolsReminders(item, t).map((line) => (
          <p key={line} className="m-0 text-body-dense">
            {line}
          </p>
        ))}
        <p className="m-0">{dolsCqcLine(item, t)}</p>
        {item.legalChangeReview ? (
          <p className="m-0">{t("care.mca.dols.legalReview", { state: item.legalChangeReview })}</p>
        ) : null}
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
          <Link href={`/people/${personId}/history/dols_authorisation/${item.id}`}>
            {t("care.mca.historyLink")}
          </Link>
        </p>
      </div>
    </Card>
  );
}
