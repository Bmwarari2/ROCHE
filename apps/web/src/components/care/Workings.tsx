import { TriangleAlert } from "lucide-react";
import type { Workings as WorkingsRead } from "@/lib/charts";
import { t } from "@/lib/i18n";

/**
 * How a validated tool's result was worked out, row by row, exactly as the API returns it
 * (medical-device boundary: the workings are shown with every result). The web app adds nothing,
 * and a row it cannot read is never dropped silently: it says how many could not be shown.
 */
export function Workings({
  workings,
  caption = t("care.workings.caption"),
}: {
  readonly workings: WorkingsRead;
  readonly caption?: string;
}) {
  const { rows, unreadable } = workings;
  if (rows.length === 0 && unreadable === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-body-dense">
            <caption className="pb-2 text-start font-semibold">{caption}</caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="py-2 pe-4 text-start font-semibold">
                  {t("care.workings.item")}
                </th>
                <th scope="col" className="py-2 pe-4 text-start font-semibold">
                  {t("care.workings.value")}
                </th>
                <th scope="col" className="py-2 text-end font-semibold">
                  {t("care.workings.points")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.item}|${row.value}|${row.points}`}
                  className="border-b border-border last:border-b-0"
                >
                  <th scope="row" className="py-2 pe-4 text-start font-normal">
                    {row.item}
                  </th>
                  <td className="py-2 pe-4">{row.value}</td>
                  <td className="py-2 text-end tabular-nums">{row.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {unreadable > 0 ? (
        <p className="m-0 flex items-start gap-2 font-semibold">
          <TriangleAlert
            size={18}
            strokeWidth={1.5}
            aria-hidden="true"
            className="mt-0.5 shrink-0"
          />
          {t("care.workings.unreadable", { count: unreadable })}
        </p>
      ) : null}
    </div>
  );
}
