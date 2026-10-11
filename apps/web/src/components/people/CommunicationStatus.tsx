import { StatusChip } from "@harbour/ui";
import type { CommunicationSummary } from "@/lib/people";
import { CommunicationFlag } from "./CommunicationFlag";

/**
 * Communication needs in a list or header (hazard HZ-023): the flag with the needs; "None
 * identified" only when someone recorded that there are none; otherwise "Not recorded" as a
 * warning chip from `@harbour/ui`, an icon and the words, never colour alone and never blank.
 */
export function CommunicationStatus({
  summary,
  flagLabel,
  compact = false,
}: {
  readonly summary: CommunicationSummary;
  /** The flag's words when needs are recorded ("Communication needs"). */
  readonly flagLabel: string;
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
      return <StatusChip status="due" label={summary.label} data-communication="not_recorded" />;
  }
}
