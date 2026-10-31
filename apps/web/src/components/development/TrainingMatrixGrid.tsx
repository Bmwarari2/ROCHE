"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { SafetyChip } from "@/components/safety/SafetyChip";
import { visibleWindow } from "@/lib/development";
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

/** Each row's height in pixels: fixed, so the window knows which rows are in view. */
const ROW_HEIGHT = 72;

/**
 * The organisation's training matrix (plan slice 57; WORK-005): one row per member of staff, one
 * column per topic, each state an icon and a word (never colour alone). A large home's matrix is
 * windowed: only the rows in view are drawn, the table still says how many rows it has
 * (aria-rowcount, and each drawn row its aria-rowindex), and the header stays in view. It uses the
 * design system's table styles; the scrolling region takes focus, so it scrolls from the keyboard.
 */
export function TrainingMatrixGrid({
  caption,
  columns,
  rows,
}: {
  readonly caption: string;
  readonly columns: readonly { readonly topic: string; readonly label: string }[];
  readonly rows: readonly MatrixRow[];
}) {
  const region = useRef<HTMLDivElement>(null);
  const captionId = useId();
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(720);

  useEffect(() => {
    const el = region.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight || 720);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const view = visibleWindow(rows.length, scrollTop, viewport, ROW_HEIGHT);
  const drawn = rows.slice(view.start, view.end);
  const span = columns.length + 1;

  return (
    // As the design system's DataTable: the scroll area is a group named by the caption, and takes
    // focus so it scrolls from the keyboard (WCAG 2.1.1).
    // biome-ignore lint/a11y/useSemanticElements: a fieldset is for form controls; this groups a table's scroll area.
    <div
      ref={region}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling area must take focus to scroll from the keyboard.
      tabIndex={0}
      role="group"
      aria-labelledby={captionId}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      className="hb-table__scroll"
      style={{ maxHeight: "70vh" }}
    >
      <table className="hb-table__table" aria-rowcount={rows.length + 1}>
        <caption id={captionId} className="hb-visually-hidden">
          {caption}
        </caption>
        <thead>
          <tr aria-rowindex={1}>
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
          {view.before > 0 ? (
            // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a spacer row standing in for rows not drawn; it holds nothing focusable.
            <tr aria-hidden="true">
              <td colSpan={span} style={{ height: view.before, padding: 0 }} />
            </tr>
          ) : null}
          {drawn.map((row, i) => (
            <tr
              key={row.id}
              aria-rowindex={view.start + i + 2}
              className="hb-table__row"
              style={{ height: ROW_HEIGHT }}
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
                    {cell ? (
                      <span className="flex flex-col gap-1">
                        <SafetyChip chip={cell.chip} />
                        {cell.until ? (
                          <span className="text-text-secondary">{cell.until}</span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="text-text-secondary">
                        {t("development.matrix.notNeeded")}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
          {view.after > 0 ? (
            // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a spacer row standing in for rows not drawn; it holds nothing focusable.
            <tr aria-hidden="true">
              <td colSpan={span} style={{ height: view.after, padding: 0 }} />
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
