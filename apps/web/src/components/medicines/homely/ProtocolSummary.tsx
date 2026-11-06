import { formatDate } from "@/lib/format";
import type { HomelyProtocol } from "@/lib/homely-remedies";
import { t } from "@/lib/i18n";

/**
 * A homely remedy protocol's figures in words, as the home agreed them with the GP or pharmacist
 * (medicines.md section 15.3): what it is for, one dose, the shortest gap, the most in 24 hours, the
 * days before the GP is asked, who agreed it and when, and the review. Each is the protocol's own
 * figure, never Harbour's.
 */
export function ProtocolSummary({
  protocol,
  staff,
}: {
  readonly protocol: HomelyProtocol;
  /** How many staff it names; omitted where the count is not wanted. */
  readonly staff?: boolean;
}) {
  const p = protocol;
  return (
    <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
      <dt className="font-semibold">{t("medicines.homely.figures.for")}</dt>
      <dd className="m-0">{p.indication}</dd>
      <dt className="font-semibold">{t("medicines.homely.figures.dose")}</dt>
      <dd className="m-0">
        {t("medicines.homely.figures.doseValue", { quantity: p.doseQuantity, unit: p.unitName })}
      </dd>
      <dt className="font-semibold">{t("medicines.homely.figures.gap")}</dt>
      <dd className="m-0">
        {t("medicines.homely.figures.gapValue", { hours: p.minIntervalHours })}
      </dd>
      <dt className="font-semibold">{t("medicines.homely.figures.daily")}</dt>
      <dd className="m-0">
        {t("medicines.homely.figures.doseValue", {
          quantity: p.maxDailyQuantity,
          unit: p.unitName,
        })}
      </dd>
      <dt className="font-semibold">{t("medicines.homely.figures.days")}</dt>
      <dd className="m-0">{t("medicines.homely.figures.daysValue", { days: p.maxDays })}</dd>
      <dt className="font-semibold">{t("medicines.homely.figures.agreed")}</dt>
      <dd className="m-0">
        {t("medicines.homely.figures.agreedValue", {
          name: p.approvedByName,
          role: p.approvedByRole,
          on: formatDate(p.approvedOn) ?? p.approvedOn,
        })}
      </dd>
      <dt className="font-semibold">{t("medicines.homely.figures.review")}</dt>
      <dd className="m-0">{formatDate(p.reviewOn) ?? p.reviewOn}</dd>
      {staff ? (
        <>
          <dt className="font-semibold">{t("medicines.homely.figures.staff")}</dt>
          <dd className="m-0">
            {t("medicines.homely.figures.staffValue", { count: p.authorisedMemberIds.length })}
          </dd>
        </>
      ) : null}
      {p.vmpId ? (
        <>
          <dt className="font-semibold">{t("medicines.homely.figures.vmp")}</dt>
          <dd className="m-0">{p.vmpId}</dd>
        </>
      ) : null}
    </dl>
  );
}
