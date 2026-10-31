import { MessageSquareText } from "lucide-react";

/**
 * Accessible Information Standard flag (section 5.4): says in words that the person has
 * communication needs, and lists them.
 */
export function CommunicationFlag({
  label,
  needs,
  compact = false,
}: {
  readonly label: string;
  readonly needs: readonly string[];
  readonly compact?: boolean;
}) {
  if (needs.length === 0) return null;
  return (
    <span className="inline-flex max-w-full flex-col items-start gap-1">
      <span className="hb-status-chip hb-status-chip--info">
        <MessageSquareText
          size={14}
          strokeWidth={1.5}
          aria-hidden="true"
          className="hb-status-chip__icon"
        />
        <span className="hb-status-chip__label">{label}</span>
      </span>
      {compact ? (
        <span className="max-w-full text-body-dense text-text-secondary [overflow-wrap:break-word]">
          {needs.join("; ")}
        </span>
      ) : null}
    </span>
  );
}
