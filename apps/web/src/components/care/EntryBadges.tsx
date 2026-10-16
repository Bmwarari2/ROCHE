import type { DeviceDeletionFlag, EntryBackEntry, EntryNotFromPaper } from "@harbour/contracts";
import { StatusChip } from "@harbour/ui";
import { Clock, Copy, FileText, History } from "lucide-react";
import { backEntryLabel } from "@/lib/downtime";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { EntryLifecycleBadges, type TaskOutcome } from "./LifecycleBadges";

/**
 * Flags on an append-only entry (hazards HZ-004, HZ-006, HZ-010, HZ-017 and HZ-040): a late entry
 * says so, with when it was recorded, so it is never mistaken for a contemporaneous record; a
 * device clock that differed from the server's is shown too; an entry recorded after the person
 * left, or one that did not complete the round it named, says what happened
 * (EntryLifecycleBadges); and an entry its device recorded deleting says so, because it may be a
 * duplicate of care recorded again (#26 review round 2, C3). A record entered from a paper
 * downtime form carries its label (the paper time, the outage, when it was entered), and one
 * written later and not from paper its reason, so neither reads as written at the time
 * (operations.md rule 12; HZ-017). Icon and word, never colour alone.
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
    deviceDeletion?: DeviceDeletionFlag | null;
    backEntry?: EntryBackEntry | null;
    notFromPaper?: EntryNotFromPaper | null;
  };
}) {
  const lifecycle = {
    recordedAfterExit: entry.recordedAfterExit === true,
    taskOutcome: entry.taskOutcome ?? null,
  };
  const hasLifecycle =
    lifecycle.recordedAfterExit ||
    (lifecycle.taskOutcome !== null && lifecycle.taskOutcome !== "completed");
  const deletion = entry.deviceDeletion ?? null;
  const backEntry = entry.backEntry ?? null;
  const notFromPaper = entry.notFromPaper ?? null;
  const downtime = backEntry !== null || notFromPaper !== null;
  if (!entry.lateEntry && !entry.clockDrift && !hasLifecycle && deletion === null && !downtime) {
    return null;
  }
  return (
    <>
      {backEntry ? (
        <>
          <StatusChip status="info" label={t("care.entry.backEntry")} icon={FileText} />
          <span className="text-body-dense text-text-secondary" data-back-entry="">
            {backEntryLabel(backEntry, t)}
          </span>
        </>
      ) : null}
      {notFromPaper ? (
        <>
          <StatusChip status="info" label={t("care.entry.notFromPaper")} icon={FileText} />
          <span className="text-body-dense text-text-secondary">
            {t("care.entry.notFromPaperReason", { reason: notFromPaper.reason })}
          </span>
        </>
      ) : null}
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
      {deletion ? (
        <span data-device-deletion={deletion}>
          <StatusChip
            status="due"
            label={t(
              deletion === "uploaded_after_deletion"
                ? "care.entry.uploadedAfterDeletion"
                : "care.entry.deletedAfterUpload",
            )}
            icon={Copy}
          />
        </span>
      ) : null}
      <EntryLifecycleBadges entry={lifecycle} />
    </>
  );
}
