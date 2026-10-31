import { StatusChip } from "@harbour/ui";
import { History, PencilLine } from "lucide-react";
import type { ReactNode } from "react";
import { entryAuthor } from "@/lib/care-record";
import { formatDateTime } from "@/lib/format";
import { type FieldText, type HistoryInput, versionViews } from "@/lib/history";
import { t } from "@/lib/i18n";

/** Invisible separators that mark where the dates go in the translated sentence. */
const MARK = String.fromCodePoint(0x2063);
const FROM = `${MARK}from${MARK}`;
const TO = `${MARK}to${MARK}`;

/** "In place from … to …" with each instant in a `<time>` element, in the sentence as translated. */
function Validity({ from, to }: { readonly from: string; readonly to: string }) {
  const times: Record<string, string> = { [FROM]: from, [TO]: to };
  const text = t("care.history.validity", { from: FROM, to: TO });
  const parts: ReactNode[] = text.split(new RegExp(`(${FROM}|${TO})`)).map((part, index) => {
    const iso = times[part];
    return iso ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed sentence
      <time key={index} dateTime={iso}>
        {formatDateTime(iso) ?? iso}
      </time>
    ) : (
      part
    );
  });
  return <span>{parts}</span>;
}

/** A field's words: one line as text, several (answers, findings) as a list. */
function FieldWords({ value }: { readonly value: FieldText }) {
  if (typeof value === "string") return <span className="break-words">{value}</span>;
  return (
    <ul className="m-0 flex list-disc flex-col gap-1 ps-5">
      {value.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: two lines may read the same
        <li key={`${index}-${line}`} className="break-words">
          {line}
        </li>
      ))}
    </ul>
  );
}

/**
 * Earlier versions of a record, newest first, each labelled as an earlier version not in use now:
 * when each was in place, who changed it, and every field as it was (a status as the status at
 * the time), marked in word and icon where it changed afterwards: "Changed in the next
 * version" for an older version, "Changed since this version" for the newest, which is compared
 * with the record as it is now.
 */
export function VersionList({
  history,
  tenantUserId,
  label,
}: {
  readonly history: HistoryInput;
  readonly tenantUserId: string;
  readonly label: string;
}) {
  const versions = versionViews(history, t);
  if (versions.length === 0) {
    return <p className="m-0 text-text-secondary">{t("care.history.versions.empty")}</p>;
  }
  // Ids for each version's heading, unique between the lists on one page (their labels differ).
  const idPrefix = `history-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <ol aria-label={label} className="hb-long-list m-0 flex list-none flex-col gap-4 p-0">
      {versions.map((version) => {
        const headingId = `${idPrefix}-v${version.version}`;
        const changedLabel =
          version.comparedWith === "now"
            ? t("care.history.changedSince")
            : t("care.history.changed");
        return (
          <li
            key={version.version}
            className="flex flex-col gap-2 rounded-input border border-border p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <p id={headingId} className="m-0 font-semibold">
                {t("care.history.version", { version: version.version })}
              </p>
              {/* Never read as the record in use (clinical safety review round 1, M1). */}
              <StatusChip status="neutral" label={t("care.history.earlier")} icon={History} />
            </div>
            <p className="m-0 flex flex-wrap gap-x-4 text-body-dense text-text-secondary">
              <Validity from={version.validFrom} to={version.validTo} />
              <span>
                {t("care.history.changedBy", {
                  who: version.changedBy ? entryAuthor(version.changedBy, tenantUserId) : "system",
                })}
              </span>
            </p>
            <table aria-labelledby={headingId} className="w-full border-collapse text-body-dense">
              <thead className="hb-visually-hidden">
                <tr>
                  <th scope="col">{t("care.history.field")}</th>
                  <th scope="col">{t("care.history.value")}</th>
                </tr>
              </thead>
              <tbody>
                {version.fields.map((field) => (
                  <tr key={field.key} className="border-b border-border align-top last:border-b-0">
                    <th
                      scope="row"
                      className="w-1/3 py-1 pe-4 text-start font-normal text-text-secondary"
                    >
                      {field.label}
                    </th>
                    <td className="py-1">
                      <FieldWords value={field.value} />
                      {field.changed ? (
                        <span
                          className={
                            typeof field.value === "string"
                              ? "ms-2 inline-block"
                              : "mt-1 inline-block"
                          }
                        >
                          <StatusChip status="info" label={changedLabel} icon={PencilLine} />
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </li>
        );
      })}
    </ol>
  );
}
