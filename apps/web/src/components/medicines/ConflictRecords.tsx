import { Check, TriangleAlert } from "lucide-react";
import type { Administration, Conflict, Uploaded } from "@/lib/administration-corrections";
import { recordsAgree, sameRecorder } from "@/lib/administration-corrections";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";

const iconProps = { size: 18, strokeWidth: 1.5, "aria-hidden": true } as const;

/** A record in words: what happened, how much, when (never colour alone). */
export function recordWords(r: Administration | Uploaded, unit: string | null): string {
  return t("medicines.conflicts.record", {
    outcome: r.outcome,
    quantity: r.amount ? String(r.amount.quantity) : "none",
    unit: unit ?? r.amount?.unitCode ?? "",
    at: r.givenAt ? (formatDateTime(r.givenAt) ?? "none") : "none",
  });
}

/**
 * Both records of a dose side by side (HZ-004; medicines.md 15.4): the record that stands (and,
 * once corrected, the record it replaced struck through), the second record as the phone sent it,
 * any further uploads, whether they agree and whether one member recorded both.
 */
export function ConflictRecords({
  conflict,
  unit,
}: {
  readonly conflict: Conflict;
  readonly unit: string | null;
}) {
  const corrected = conflict.current.id !== conflict.standing.id;
  const agree = recordsAgree(conflict);
  return (
    <div className="flex flex-col gap-3">
      <dl className="m-0 grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1 rounded-input border border-border p-3">
          <dt className="font-semibold">{t("medicines.conflicts.first")}</dt>
          {corrected ? (
            <dd className="m-0">
              <del>{recordWords(conflict.standing, unit)}</del>
              <span className="sr-only"> {t("medicines.conflicts.replaced")}</span>
            </dd>
          ) : null}
          <dd className="m-0">{recordWords(conflict.current, unit)}</dd>
          {corrected && conflict.current.correctionReason ? (
            <dd className="m-0">
              {t("medicines.conflicts.correctedBecause", {
                reason: conflict.current.correctionReason,
              })}
            </dd>
          ) : null}
        </div>
        <div className="flex flex-col gap-1 rounded-input border border-border p-3">
          <dt className="font-semibold">{t("medicines.conflicts.second")}</dt>
          <dd className="m-0">{recordWords(conflict.uploaded, unit)}</dd>
          {conflict.joined.map((j) => (
            <dd key={j.id} className="m-0">
              {t("medicines.conflicts.sentAgain", { record: recordWords(j, unit) })}
            </dd>
          ))}
          <dd className="m-0">
            {t("medicines.conflicts.received", {
              at: formatDateTime(conflict.receivedAt) ?? "",
            })}
          </dd>
        </div>
      </dl>
      <p className="m-0 flex items-start gap-2">
        {agree ? <Check {...iconProps} /> : <TriangleAlert {...iconProps} />}
        <span>{t(agree ? "medicines.conflicts.same" : "medicines.conflicts.differ")}</span>
      </p>
      <p className="m-0">
        {t(
          sameRecorder(conflict)
            ? "medicines.conflicts.sameRecorder"
            : "medicines.conflicts.twoRecorders",
        )}
      </p>
    </div>
  );
}
