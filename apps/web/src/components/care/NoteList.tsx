import type { CareNoteItem } from "@harbour/contracts";
import { Timeline, type TimelineEntry } from "@harbour/ui";
import { NotebookPen } from "lucide-react";
import { entryAuthor, entryChains } from "@/lib/care-record";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";
import { EntryBadges } from "./EntryBadges";
import { NoteCorrection } from "./NoteCorrection";

/**
 * Daily notes, newest first. A corrected note shows the original struck through, the correction,
 * who corrected it, when and why (CONTENT.md, corrections); longer histories are one tap away.
 * Late entries are flagged (HZ-017). The list is grouped by correction chain, so a correction
 * never appears as a separate, unconnected note.
 */
export function NoteList({
  notes,
  label,
  personId,
  tenantUserId,
  canWrite,
}: {
  readonly notes: readonly CareNoteItem[];
  readonly label: string;
  readonly personId: string;
  readonly tenantUserId: string;
  readonly canWrite: boolean;
}) {
  const entries: TimelineEntry[] = entryChains(notes).map((chain) => {
    const original = chain.earlier[0] ?? chain.current;
    const current = chain.current;
    const corrected = chain.earlier.length > 0;
    const who = (recordedBy: string | null) => entryAuthor(recordedBy, tenantUserId);
    const previous = chain.earlier.slice(0, -1);
    return {
      // The chain's first entry, so a correction form keeps its state when the list refreshes.
      id: original.id,
      author: t("care.entry.recordedBy", { who: who(original.recordedBy) }),
      time: original.occurredAt,
      timeLabel: formatDateTime(original.occurredAt) ?? undefined,
      title: t("care.notes.category", { category: current.category }),
      icon: <NotebookPen size={14} strokeWidth={1.5} aria-hidden="true" />,
      badges: <EntryBadges entry={original} />,
      body: (chain.earlier.at(-1) ?? current).body,
      ...(corrected
        ? {
            correction: {
              body: current.body,
              author: t("care.entry.recordedBy", { who: who(current.recordedBy) }),
              time: current.recordedAt,
              meta: t("care.timeline.correctedBy", {
                who: who(current.recordedBy),
                dateTime: formatDateTime(current.recordedAt) ?? "",
              }),
              ...(current.correctionReason
                ? { reasonText: t("care.timeline.reason", { reason: current.correctionReason }) }
                : {}),
            },
          }
        : {}),
      footer: (
        <>
          {chain.correctsHidden ? (
            <p className="m-0 text-body-dense text-text-secondary">
              {t("care.timeline.correctsHidden")}
            </p>
          ) : null}
          {previous.length > 0 ? (
            <details className="text-body-dense">
              <summary className="inline-flex min-h-target cursor-pointer items-center text-link">
                {t("care.timeline.earlier", { count: previous.length })}
              </summary>
              <ol className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
                {previous.map((version) => (
                  <li key={version.id} className="rounded-input border border-border px-4 py-2">
                    <p className="m-0 text-text-secondary">
                      {t("care.timeline.earlierVersion", {
                        dateTime: formatDateTime(version.recordedAt) ?? "",
                      })}
                    </p>
                    <del className="text-text-secondary">{version.body}</del>
                    {version.correctionReason ? (
                      <p className="m-0 text-text-secondary">
                        {t("care.timeline.reason", { reason: version.correctionReason })}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
          {canWrite ? (
            <NoteCorrection
              personId={personId}
              note={{
                id: current.id,
                category: current.category,
                body: current.body,
                occurredAt: current.occurredAt,
              }}
            />
          ) : null}
        </>
      ),
    };
  });

  return (
    <Timeline
      entries={entries}
      label={label}
      labels={{
        originalEntry: t("care.timeline.originalEntry"),
        correction: t("care.timeline.correction"),
      }}
      className="hb-long-list"
    />
  );
}
