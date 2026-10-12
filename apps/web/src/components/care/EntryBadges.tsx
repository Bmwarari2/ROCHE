import { StatusChip } from "@harbour/ui";
import { Clock, History } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { EntryLifecycleBadges, type TaskOutcome } from "./LifecycleBadges";

/**
 * Flags on an append-only entry (hazards HZ-004, HZ-006, HZ-010 and HZ-017): a late entry says
 * so, with when it was recorded, so it is never mistaken for a contemporaneous record; a device
 * clock that differed from the server's is shown too; and an entry recorded after the person left,
 * or one that did not complete the round it named, says what happened (EntryLifecycleBadges).
 * Icon and word, never colour alone.
 */
export function EntryBadges({
  entry,
}: {
  readonly entry: {
    lateEntry: boolean;
    clockDrift: boolean;
    recordedAt: string;
    recordedAfterExit?: boolean;
    taskOutcome?: TaskOutcome | null;
  };
}) {
  const lifecycle = {
    recordedAfterExit: entry.recordedAfterExit === true,
    taskOutcome: entry.taskOutcome ?? null,
  };
  const hasLifecycle =
    lifecycle.recordedAfterExit ||
    (lifecycle.taskOutcome !== null && lifecycle.taskOutcome !== "completed");
  if (!entry.lateEntry && !entry.clockDrift && !hasLifecycle) return null;
  return (
    <>
      {entry.lateEntry ? (
        <>
          <StatusChip status="due" label={t("care.entry.lateEntry")} icon={Clock} />
          <span className="text-body-dense text-text-secondary">
            {t("care.entry.recordedAt", { dateTime: formatDateTime(entry.recordedAt) ?? "" })}
          </span>
        </>
      ) : null}
      {entry.clockDrift ? (
        <StatusChip status="info" label={t("care.entry.clockDrift")} icon={History} />
      ) : null}
      <EntryLifecycleBadges entry={lifecycle} />
    </>
  );
}
