import { Card } from "@harbour/ui";
import { SafetyChip } from "@/components/safety/SafetyChip";
import { dpiaChip } from "@/lib/dpia";
import { formatDateTime } from "@/lib/format";
import { t } from "@/lib/i18n";

/**
 * Where the DPIA stands (PLAT-023): the state as an icon and a word, who signed it and when, the
 * review date, why a review is due, and the details Harbour still needs before it can be signed.
 */
export interface DpiaStatusView {
  readonly state: string;
  readonly signed: {
    readonly signedAt: string | null;
    readonly signedBy: { readonly displayName: string } | null;
  } | null;
  readonly reviewDueAt: string | null;
  readonly triggers: readonly { readonly kind: string }[];
  readonly missingConfig: readonly string[];
}

export function DpiaStatus({ dpia }: { readonly dpia: DpiaStatusView }) {
  return (
    <Card as="section" title={t("dpia.status.title")} headingLevel={2}>
      <div className="flex flex-col gap-3">
        <p className="m-0">
          <SafetyChip chip={dpiaChip(dpia.state, t)} />
        </p>
        {dpia.signed?.signedAt ? (
          <p className="m-0 text-body-dense">
            {t("dpia.status.signed", {
              name: dpia.signed.signedBy?.displayName ?? "",
              dateTime: formatDateTime(dpia.signed.signedAt) ?? "",
            })}
          </p>
        ) : null}
        {dpia.reviewDueAt ? (
          <p className="m-0 text-body-dense">
            {t("dpia.status.reviewBy", {
              date: formatDateTime(dpia.reviewDueAt)?.split(" ")[0] ?? "",
            })}
          </p>
        ) : null}
        {dpia.triggers.length > 0 ? (
          <ul className="m-0 flex flex-col gap-1 ps-5">
            {dpia.triggers.map((trigger) => (
              <li key={trigger.kind}>{t("dpia.trigger", { kind: trigger.kind })}</li>
            ))}
          </ul>
        ) : null}
        {dpia.missingConfig.length > 0 ? (
          <div className="flex flex-col gap-1">
            <p className="m-0 font-semibold">{t("dpia.missing.title")}</p>
            <ul className="m-0 flex flex-col gap-1 ps-5">
              {dpia.missingConfig.map((key) => (
                <li key={key}>{t("dpia.missing", { key: key.replace(".", "_") })}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
