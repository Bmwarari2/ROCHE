import { StatusChip } from "@harbour/ui";
import type { CommunicationSummary } from "@/lib/people";
import { CommunicationFlag } from "./CommunicationFlag";

/**
 * Communication needs in a list or header (hazard HZ-023): the flag with the needs; "None
 * identified" only when someone recorded that there are none; otherwise "Not recorded" with the
 * shared `notRecorded` chip from `@harbour/ui` (a question mark and the words, never colour alone,
 * never blank), linked to where they are recorded when that page is given.
 */
export function CommunicationStatus({
  summary,
  flagLabel,
  recordHref,
  compact = false,
}: {
  readonly summary: CommunicationSummary;
  /** The flag's words when needs are recorded ("Communication needs"). */
  readonly flagLabel: string;
  /** Where the needs are recorded, so the warning is one step from being resolved. */
  readonly recordHref?: string;
  readonly compact?: boolean;
}) {
  switch (summary.kind) {
    case "recorded":
      return <CommunicationFlag label={flagLabel} needs={summary.needs} compact={compact} />;
    case "none_identified":
      return (
        <span className="text-text-secondary" data-communication="none_identified">
          {summary.label}
        </span>
      );
    default:
      return (
        <StatusChip
          status="notRecorded"
          label={summary.label}
          data-communication="not_recorded"
          {...(recordHref ? { href: recordHref } : {})}
        />
      );
  }
}
