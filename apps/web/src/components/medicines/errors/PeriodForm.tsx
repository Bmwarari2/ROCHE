import { Button, DateInput } from "@harbour/ui";
import { CalendarRange } from "lucide-react";
import { WarningArrival } from "@/components/care/WarningArrival";
import { t } from "@/lib/i18n";
import type { Period } from "@/lib/medication-errors";

const dateLabels = {
  day: t("care.date.day"),
  month: t("care.date.month"),
  year: t("care.date.year"),
};

/**
 * The report period (the contract's `from` and `to`, UK dates, inclusive), chosen with the date
 * boxes and sent in the page's address, so the report can be bookmarked and works without
 * scripts. A date that cannot be read is said at its field; the API says when a period is too long.
 */
export function PeriodForm({
  action,
  period,
  errors,
}: {
  readonly action: string;
  readonly period: Period;
  readonly errors: Readonly<Record<string, string>> | null;
}) {
  return (
    <form method="get" action={action} className="flex flex-col gap-4" noValidate>
      {errors && Object.keys(errors).length > 0 ? (
        // The page reloads with the errors, so they are said once on arrival and take focus.
        <WarningArrival>
          {t("medicines.errors.period.problem")} {Object.values(errors).join(" ")}
        </WarningArrival>
      ) : null}
      <div className="flex flex-wrap gap-6">
        <DateInput
          id="period-from"
          name="from"
          legend={t("medicines.errors.period.from")}
          labels={dateLabels}
          defaultValue={period.from}
          {...(errors?.from ? { error: errors.from } : {})}
        />
        <DateInput
          id="period-to"
          name="to"
          legend={t("medicines.errors.period.to")}
          labels={dateLabels}
          defaultValue={period.to}
          {...(errors?.to ? { error: errors.to } : {})}
        />
      </div>
      <div>
        <Button
          type="submit"
          variant="secondary"
          icon={<CalendarRange size={18} strokeWidth={1.5} aria-hidden="true" />}
        >
          {t("medicines.errors.period.submit")}
        </Button>
      </div>
    </form>
  );
}
