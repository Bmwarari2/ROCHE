import type { RecordHistory } from "@harbour/contracts";
import { StatusChip } from "@harbour/ui";
import { PencilLine } from "lucide-react";
import { entryAuthor } from "@/lib/care-record";
import { formatDateTime } from "@/lib/format";
import { versionViews } from "@/lib/history";
import { t } from "@/lib/i18n";

/**
 * Earlier versions of a record, newest first: when each was in place, who changed it, and every
 * field as it was, with the fields the next version changed marked in word and icon.
 */
export function VersionList({
  history,
  tenantUserId,
  label,
}: {
  readonly history: Pick<RecordHistory, "versions">;
  readonly tenantUserId: string;
  readonly label: string;
}) {
  const versions = versionViews(history, t);
  if (versions.length === 0) {
    return <p className="m-0 text-text-secondary">{t("care.history.versions.empty")}</p>;
  }
  return (
    <ol aria-label={label} className="hb-long-list m-0 flex list-none flex-col gap-4 p-0">
      {versions.map((version) => (
        <li
          key={version.version}
          className="flex flex-col gap-2 rounded-input border border-border p-4"
        >
          <p className="m-0 font-semibold">
            {t("care.history.version", { version: version.version })}
          </p>
          <p className="m-0 flex flex-wrap gap-x-4 text-callout text-text-secondary">
            <span>
              {t("care.history.validity", {
                from: formatDateTime(version.validFrom) ?? "",
                to: formatDateTime(version.validTo) ?? "",
              })}
            </span>
            <span>
              {t("care.history.changedBy", {
                who: version.changedBy ? entryAuthor(version.changedBy, tenantUserId) : "system",
              })}
            </span>
          </p>
          <table className="w-full border-collapse text-callout">
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
                    <span className="whitespace-pre-line break-words">{field.value}</span>
                    {field.changedNext ? (
                      <span className="ms-2 inline-block">
                        <StatusChip
                          status="info"
                          label={t("care.history.changed")}
                          icon={PencilLine}
                        />
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </li>
      ))}
    </ol>
  );
}
