import type { ScoreWorking } from "@/lib/charts";
import { t } from "@/lib/i18n";

/**
 * How a validated tool's result was worked out, row by row, exactly as the API returns it
 * (medical-device boundary: the workings are shown with every result). The web app adds nothing.
 */
export function Workings({
  workings,
  caption = t("care.workings.caption"),
}: {
  readonly workings: readonly ScoreWorking[];
  readonly caption?: string;
}) {
  if (workings.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-callout">
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
          {workings.map((row) => (
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
  );
}
