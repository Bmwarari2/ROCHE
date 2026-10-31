import Link from "next/link";
import { SafetyChip } from "@/components/safety/SafetyChip";
import { notNeededChip } from "@/lib/development";
import { t } from "@/lib/i18n";
import type { SafetyChip as Chip } from "@/lib/incidents";

export interface MatrixCell {
  readonly chip: Chip;
  /** "Until dd/mm/yyyy", or empty when missing. */
  readonly until: string;
}

export interface MatrixRow {
  readonly id: string;
  readonly href: string;
  readonly name: string;
  readonly jobTitle: string | null;
  readonly cells: Readonly<Record<string, MatrixCell | undefined>>;
}

/**
 * The organisation's training matrix (plan slice 57; WORK-005): one row per member of staff, one
 * column per topic, each state an icon and a word (never colour alone), in the design system's
 * table styles with the header kept in view.
 *
 * Large homes: every row stays in the page, so screen reader table navigation and find-in-page
 * reach every member of staff, and focus is never lost to a row taken away. The browser skips
 * laying out and painting rows out of view (`content-visibility: auto` with an intrinsic size),
 * which keeps a home of hundreds quick; the API returns at most 2,000 members (accessibility
 * review round 1, findings 1 to 3). The scroll area keeps a focused link clear of the sticky header
 * (scroll padding) and takes focus, so it scrolls from the keyboard.
 */
export function TrainingMatrixGrid({
  caption,
  captionId,
  columns,
  rows,
}: {
  readonly caption: string;
  readonly captionId: string;
  readonly columns: readonly { readonly topic: string; readonly label: string }[];
  readonly rows: readonly MatrixRow[];
}) {
  return (
    // As the design system's DataTable: the scroll area is a group named by the caption.
    // biome-ignore lint/a11y/useSemanticElements: a fieldset is for form controls; this groups a table's scroll area.
    <div
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling area must take focus to scroll from the keyboard (WCAG 2.1.1).
      tabIndex={0}
      role="group"
      aria-labelledby={captionId}
      className="hb-table__scroll"
      style={{ maxHeight: "70vh", scrollPaddingTop: "var(--touch-target)" }}
    >
      <table className="hb-table__table">
        <caption id={captionId} className="hb-visually-hidden">
          {caption}
        </caption>
        <thead>
          <tr>
            <th scope="col" className="hb-table__th" style={{ minWidth: "14rem" }}>
              {t("development.matrix.member")}
            </th>
            {columns.map((column) => (
              <th
                key={column.topic}
                scope="col"
                className="hb-table__th"
                style={{ minWidth: "10rem" }}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className="hb-table__row"
              style={{ contentVisibility: "auto", containIntrinsicSize: "auto 6rem" }}
            >
              <th scope="row" className="hb-table__td text-left font-normal">
                <Link
                  href={row.href}
                  className="inline-flex min-h-target items-center font-semibold underline"
                >
                  {row.name}
                </Link>
                {row.jobTitle ? (
                  <span className="block text-text-secondary">{row.jobTitle}</span>
                ) : null}
              </th>
              {columns.map((column) => {
                const cell = row.cells[column.topic];
                return (
                  <td key={column.topic} className="hb-table__td">
                    <span className="flex flex-col gap-1">
                      <SafetyChip chip={cell ? cell.chip : notNeededChip(t)} />
                      {cell?.until ? (
                        <span className="text-text-secondary">{cell.until}</span>
                      ) : null}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
