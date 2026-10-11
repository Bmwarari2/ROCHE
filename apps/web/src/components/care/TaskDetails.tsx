import type { TaskDetails as TaskDetailsData } from "@harbour/contracts";
import type { MessageKey } from "@harbour/i18n";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";

/** Words for the kinds of entry a review lists; anything else is shown as it is stored. */
const ENTRY_KINDS: Record<string, MessageKey> = {
  care_note: "care.taskDetails.kind.note",
  observation: "care.taskDetails.kind.observation",
  body_map_mark: "care.taskDetails.kind.bodyMap",
  assessment: "care.taskDetails.kind.assessment",
  activity_record: "care.taskDetails.kind.activity",
  visit_log: "care.taskDetails.kind.visit",
  incident: "care.taskDetails.kind.incident",
};

const OUTCOMES: Record<string, MessageKey> = {
  task_cancelled: "care.entry.taskCancelled",
  task_already_closed: "care.entry.taskAlreadyClosed",
  not_linked: "care.entry.notLinked",
  medicines_conflict: "care.entry.medicinesConflict",
  task_changed: "care.taskDetails.taskChanged",
};

/** A round's kind in words: the last part of `module.what`, never a raw code on screen alone. */
function roundKind(kind: string): string {
  const what = kind.split(".").at(-1) ?? kind;
  const words = what.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What a review task lists (people.md rules 2 and 3, care.md rule 13; C-M7, C8): the rounds missed
 * during a late return or correction, each with its due time (UK time) and whether it was caught
 * up, and the entries to review by kind, time and what happened to their round, with the opaque
 * ids that find them on the device. Never clinical text.
 */
export function TaskDetails({ details }: { readonly details: TaskDetailsData | null }) {
  if (!details) return null;
  const missed = details.missedTasks ?? [];
  const entries = details.entries ?? [];
  if (missed.length === 0 && entries.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {missed.length > 0 ? (
        <section aria-label={t("care.taskDetails.missedTitle")} className="flex flex-col gap-1">
          <h4 className="m-0 text-body font-semibold">{t("care.taskDetails.missedTitle")}</h4>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {missed.map((m) => (
              <li key={m.taskId} data-missed-task={m.taskId}>
                {t("care.taskDetails.missedItem", {
                  kind: roundKind(m.kind),
                  due: formatDateTime(m.dueAt) ?? "",
                  reopened: m.reopened ? "yes" : "no",
                })}
              </li>
            ))}
          </ul>
          {details.missedTasksOmitted ? (
            <p className="m-0 text-body-dense text-text-secondary">
              {t("care.taskDetails.omitted", { count: details.missedTasksOmitted })}
            </p>
          ) : null}
        </section>
      ) : null}
      {entries.length > 0 ? (
        <section aria-label={t("care.taskDetails.entriesTitle")} className="flex flex-col gap-1">
          <h4 className="m-0 text-body font-semibold">{t("care.taskDetails.entriesTitle")}</h4>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {entries.map((e, n) => {
              const kindKey = ENTRY_KINDS[e.kind];
              const outcomeKey = e.outcome ? OUTCOMES[e.outcome] : undefined;
              return (
                <li key={`${e.entryId ?? e.clientId ?? n}`} className="flex flex-col">
                  <span>
                    {t("care.taskDetails.entryItem", {
                      kind: kindKey ? t(kindKey) : e.kind,
                      when: formatDateTime(e.occurredAt ?? e.at ?? null) ?? "",
                    })}
                    {outcomeKey ? ` ${t(outcomeKey)}` : ""}
                  </span>
                  <span className="text-body-dense text-text-secondary tabular-nums">
                    {t("care.taskDetails.entryRefs", {
                      id: e.clientId ?? e.entryId ?? "-",
                      device: e.deviceId ?? "-",
                    })}
                  </span>
                </li>
              );
            })}
          </ul>
          {details.entriesOmitted ? (
            <p className="m-0 text-body-dense text-text-secondary">
              {t("care.taskDetails.omitted", { count: details.entriesOmitted })}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
