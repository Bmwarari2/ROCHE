import type { DeviceSummary } from "@/lib/care-devices";
import { namesInWords } from "@/lib/care-devices";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";

/** A time in words inside a `<time>` element (CONTENT.md rule 6); "not known" when unreadable. */
function When({ iso }: { readonly iso: string }) {
  return <time dateTime={iso}>{formatDateTime(iso) ?? t("devices.timeUnknown")}</time>;
}

/** What is known about a phone: who used it, when, and what it last reported waiting. */
export function DeviceFacts({
  device,
  firstSeen = false,
}: {
  readonly device: DeviceSummary;
  readonly firstSeen?: boolean;
}) {
  const names = namesInWords(device.members.map((m) => m.name));
  return (
    <>
      <p className="m-0 text-body-dense">{t("devices.usedBy", { names })}</p>
      {firstSeen ? (
        <p className="m-0 text-body-dense">
          {t("devices.firstSeen")} <When iso={device.firstSeenAt} />
        </p>
      ) : null}
      <p className="m-0 text-body-dense">
        {t("devices.lastSeen")} <When iso={device.lastSeenAt} />
      </p>
      <p className="m-0 text-body-dense">
        {device.lastReportedAt ? (
          <>
            {t("devices.reportedAt")} <When iso={device.lastReportedAt} />
          </>
        ) : (
          t("devices.neverReported")
        )}
      </p>
      {device.lastReportedAt ? (
        <p className="m-0 text-body-dense">
          {t("devices.waiting", { count: device.entriesWaiting })}
        </p>
      ) : null}
      {device.revokedAt ? (
        <>
          <p className="m-0 text-body-dense">
            {t("devices.withdrawnAt")} <When iso={device.revokedAt} />
          </p>
          <p className="m-0 text-body-dense">
            {t("devices.withdrawnReason")}{" "}
            {t("devices.reason", { reason: device.revocationReason ?? "other" })}
          </p>
        </>
      ) : null}
    </>
  );
}
