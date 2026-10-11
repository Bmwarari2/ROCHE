import { Circle, PencilLine } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../../lib/cx";
import { formatUkDateTime } from "../../lib/datetime";
import { iconProps } from "../../lib/icon";

export interface TimelineCorrection {
  /** The corrected text that replaces the original. */
  body: ReactNode;
  author: string;
  /** ISO 8601 timestamp of the correction. */
  time: string;
  /** Display text for the time; defaults to dd/mm/yyyy HH:mm in UK time. */
  timeLabel?: string;
  reason?: string;
  /**
   * Replaces the "Corrected by ... on ..." line, so apps can pass a translated whole sentence
   * ("Corrected by Ben Sample on 03/10/2026 11:12").
   */
  meta?: ReactNode;
  /** Replaces the "Reason: ..." line with translated words. */
  reasonText?: ReactNode;
}

/** Words the timeline adds itself; apps pass translated ones. */
export interface TimelineLabels {
  /** Read before the struck-through original: "Original entry, now corrected:". */
  originalEntry?: string;
  /** The heading over the correction: "Correction". */
  correction?: string;
}

export interface TimelineEntry {
  id: string;
  author: string;
  /** For example "Senior carer". */
  authorRole?: string;
  /** ISO 8601 timestamp. */
  time: string;
  /** Display text for the time; defaults to dd/mm/yyyy HH:mm in UK time. */
  timeLabel?: string;
  title?: ReactNode;
  /** Status chips shown with the time, for example "Late entry" (icon and word). */
  badges?: ReactNode;
  body: ReactNode;
  /** A decorative Lucide icon for the entry type. */
  icon?: ReactNode;
  /**
   * Care notes are immutable: a correction is a new event that references the original. The
   * original stays visible with a single line through it, followed by the correction, its time
   * and its author.
   */
  correction?: TimelineCorrection;
  /** Shown under the entry, for example "Correct this note" or the earlier versions. */
  footer?: ReactNode;
}

export interface TimelineProps extends HTMLAttributes<HTMLOListElement> {
  entries: readonly TimelineEntry[];
  /** Accessible name of the list, for example "Care notes" or "Record history". */
  label?: string;
  labels?: TimelineLabels;
}

function TimeStamp({ time, label }: { time: string; label: string | undefined }) {
  return <time dateTime={time}>{label ?? formatUkDateTime(time)}</time>;
}

/** A feed of notes or audit history, newest first or oldest first as the caller orders it. */
export function Timeline({
  entries,
  label = "History",
  labels,
  className,
  ...rest
}: TimelineProps) {
  return (
    <ol className={cx("hb-timeline", className)} aria-label={label} {...rest}>
      {entries.map((entry) => {
        const { correction } = entry;
        return (
          <li
            key={entry.id}
            className={cx("hb-timeline__entry", correction && "hb-timeline__entry--corrected")}
          >
            <span className="hb-timeline__marker" aria-hidden="true">
              {entry.icon ?? <Circle {...iconProps} size={12} />}
            </span>
            <div className="hb-timeline__content">
              <p className="hb-timeline__meta">
                <span className="hb-timeline__author">{entry.author}</span>
                {entry.authorRole ? (
                  <span className="hb-timeline__role">{entry.authorRole}</span>
                ) : null}
                <TimeStamp time={entry.time} label={entry.timeLabel} />
                {entry.badges != null ? (
                  <span className="hb-timeline__badges">{entry.badges}</span>
                ) : null}
              </p>
              {entry.title != null ? <p className="hb-timeline__title">{entry.title}</p> : null}
              {correction ? (
                <>
                  <div className="hb-timeline__original">
                    <span className="hb-visually-hidden">
                      {labels?.originalEntry ?? "Original entry, now corrected:"}{" "}
                    </span>
                    <del className="hb-timeline__body hb-timeline__body--struck">{entry.body}</del>
                  </div>
                  <div className="hb-timeline__correction">
                    <p className="hb-timeline__correction-label">
                      <PencilLine {...iconProps} size={14} />
                      <span>{labels?.correction ?? "Correction"}</span>
                    </p>
                    <ins className="hb-timeline__body hb-timeline__body--correction">
                      {correction.body}
                    </ins>
                    <p className="hb-timeline__correction-meta">
                      {correction.meta ?? (
                        <>
                          Corrected by{" "}
                          <span className="hb-timeline__author">{correction.author}</span> on{" "}
                          <TimeStamp time={correction.time} label={correction.timeLabel} />
                        </>
                      )}
                    </p>
                    {correction.reasonText != null ? (
                      <p className="hb-timeline__correction-reason">{correction.reasonText}</p>
                    ) : correction.reason ? (
                      <p className="hb-timeline__correction-reason">Reason: {correction.reason}</p>
                    ) : null}
                  </div>
                </>
              ) : (
                <div className="hb-timeline__body">{entry.body}</div>
              )}
              {entry.footer != null ? (
                <div className="hb-timeline__footer">{entry.footer}</div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
