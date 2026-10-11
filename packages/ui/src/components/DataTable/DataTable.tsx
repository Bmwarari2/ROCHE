"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { cx } from "../../lib/cx";
import { iconProps } from "../../lib/icon";
import { SegmentedControl } from "../SegmentedControl/SegmentedControl";

export type SortDirection = "ascending" | "descending";

export interface SortState {
  columnId: string;
  direction: SortDirection;
}

export type TableDensity = "comfortable" | "compact";

export type SortValue = string | number | Date | null | undefined;

export interface DataTableColumn<Row> {
  id: string;
  /** Column heading text. */
  header: string;
  cell: (row: Row) => ReactNode;
  /** The value to sort by. Columns with a sort value get a sort button in their heading. */
  sortValue?: (row: Row) => SortValue;
  /** Right-aligns the column; use for numbers. */
  align?: "start" | "end";
  /** Marks the column that names each row (for example the person's name) as the row header. */
  rowHeader?: boolean;
  /** CSS width, for example "12rem". */
  width?: string;
}

export interface DataTableProps<Row> {
  /** Names the table. Always required; hide it visually with `hideCaption`. */
  caption: string;
  hideCaption?: boolean;
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  getRowId: (row: Row) => string;
  /** Controlled sort. Omit to let the table manage sorting itself. */
  sort?: SortState | null;
  defaultSort?: SortState | null;
  onSortChange?: (sort: SortState) => void;
  /** Set when rows arrive already sorted (for example from the server). */
  manualSorting?: boolean;
  density?: TableDensity;
  defaultDensity?: TableDensity;
  onDensityChange?: (density: TableDensity) => void;
  showDensityToggle?: boolean;
  /** Called with Enter or Space on a focused row, or a click on a row. */
  onRowActivate?: (row: Row) => void;
  /** Id of the row shown as selected, for example the one open in an inspector panel. */
  selectedRowId?: string;
  /** Shown in place of rows when there are none. */
  emptyState?: ReactNode;
  /** Extra controls shown before the density toggle, such as a search field. */
  toolbar?: ReactNode;
  /** Maximum height of the scrolling area; the header stays visible while rows scroll. */
  maxHeight?: string;
  className?: string;
}

const collator = new Intl.Collator("en-GB", { numeric: true, sensitivity: "base" });

function compareValues(a: SortValue, b: SortValue): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  return collator.compare(String(a), String(b));
}

const densityOptions = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
] as const;

const PAGE_STEP = 10;

/**
 * A data table for the product shell: sticky header, tabular numbers, sortable columns with
 * aria-sort, a density toggle and keyboard navigation. Rows use a roving tabindex: Tab reaches the
 * active row, arrow keys, Home, End, Page Up and Page Down move between rows.
 */
export function DataTable<Row>({
  caption,
  hideCaption = false,
  columns,
  rows,
  getRowId,
  sort: sortProp,
  defaultSort = null,
  onSortChange,
  manualSorting = false,
  density: densityProp,
  defaultDensity = "comfortable",
  onDensityChange,
  showDensityToggle = true,
  onRowActivate,
  selectedRowId,
  emptyState,
  toolbar,
  maxHeight = "70vh",
  className,
}: DataTableProps<Row>) {
  const [uncontrolledSort, setUncontrolledSort] = useState<SortState | null>(defaultSort);
  const [uncontrolledDensity, setUncontrolledDensity] = useState<TableDensity>(defaultDensity);
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());

  const sort = sortProp === undefined ? uncontrolledSort : sortProp;
  const density = densityProp ?? uncontrolledDensity;

  const sortedRows = useMemo(() => {
    if (!sort || manualSorting) return rows;
    const column = columns.find((candidate) => candidate.id === sort.columnId);
    const sortValue = column?.sortValue;
    if (!sortValue) return rows;
    const factor = sort.direction === "ascending" ? 1 : -1;
    return [...rows].sort((a, b) => factor * compareValues(sortValue(a), sortValue(b)));
  }, [rows, columns, sort, manualSorting]);

  const rowIds = useMemo(() => sortedRows.map(getRowId), [sortedRows, getRowId]);
  const focusableRowId =
    activeRowId !== null && rowIds.includes(activeRowId) ? activeRowId : (rowIds[0] ?? null);

  const changeSort = (columnId: string) => {
    const next: SortState =
      sort?.columnId === columnId && sort.direction === "ascending"
        ? { columnId, direction: "descending" }
        : { columnId, direction: "ascending" };
    if (sortProp === undefined) {
      setUncontrolledSort(next);
    }
    onSortChange?.(next);
  };

  const changeDensity = (next: TableDensity) => {
    if (densityProp === undefined) {
      setUncontrolledDensity(next);
    }
    onDensityChange?.(next);
  };

  const focusRow = useCallback(
    (index: number) => {
      const id = rowIds[index];
      if (id === undefined) return;
      setActiveRowId(id);
      rowRefs.current.get(id)?.focus();
    },
    [rowIds],
  );

  const onRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, index: number, row: Row) => {
    // Leave keys alone when they come from a control inside a cell.
    if (event.target !== event.currentTarget) return;
    const last = rowIds.length - 1;
    let next: number | null = null;
    switch (event.key) {
      case "ArrowDown":
        next = Math.min(index + 1, last);
        break;
      case "ArrowUp":
        next = Math.max(index - 1, 0);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      case "PageDown":
        next = Math.min(index + PAGE_STEP, last);
        break;
      case "PageUp":
        next = Math.max(index - PAGE_STEP, 0);
        break;
      case "Enter":
      case " ":
        if (onRowActivate) {
          event.preventDefault();
          onRowActivate(row);
        }
        return;
      default:
        return;
    }
    event.preventDefault();
    focusRow(next);
  };

  const onRowClick = (event: MouseEvent<HTMLTableRowElement>, id: string, row: Row) => {
    setActiveRowId(id);
    const target = event.target as HTMLElement;
    // A click on a link or button inside the row does its own thing.
    if (target.closest("a, button, input, select, textarea, label")) return;
    onRowActivate?.(row);
  };

  return (
    <div className={cx("hb-table", className)} data-density={density}>
      {showDensityToggle || toolbar != null ? (
        <div className="hb-table__toolbar">
          {toolbar}
          {showDensityToggle ? (
            <SegmentedControl
              label="Row density"
              hideLabel
              options={densityOptions}
              value={density}
              onValueChange={changeDensity}
              className="hb-table__density"
            />
          ) : null}
        </div>
      ) : null}
      <div className="hb-table__scroll" style={{ maxHeight }}>
        <table className="hb-table__table">
          <caption className={hideCaption ? "hb-visually-hidden" : "hb-table__caption"}>
            {caption}
          </caption>
          <thead>
            <tr>
              {columns.map((column) => {
                const sorted = sort?.columnId === column.id ? sort.direction : undefined;
                return (
                  <th
                    key={column.id}
                    scope="col"
                    aria-sort={sorted}
                    className={cx("hb-table__th", column.align === "end" && "hb-table__cell--end")}
                    style={column.width ? { width: column.width } : undefined}
                  >
                    {column.sortValue ? (
                      <button
                        type="button"
                        className="hb-table__sort"
                        onClick={() => changeSort(column.id)}
                      >
                        <span>{column.header}</span>
                        {sorted === "ascending" ? (
                          <ArrowUp {...iconProps} size={14} className="hb-table__sort-icon" />
                        ) : sorted === "descending" ? (
                          <ArrowDown {...iconProps} size={14} className="hb-table__sort-icon" />
                        ) : (
                          <ArrowUpDown
                            {...iconProps}
                            size={14}
                            className="hb-table__sort-icon hb-table__sort-icon--idle"
                          />
                        )}
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.length === 0 ? (
              <tr className="hb-table__empty-row">
                <td colSpan={columns.length}>{emptyState ?? "There is nothing to show yet."}</td>
              </tr>
            ) : (
              sortedRows.map((row, index) => {
                const id = rowIds[index] ?? getRowId(row);
                return (
                  // Rows take part in a roving tabindex so keyboard users can move through records
                  // with the arrow keys.
                  <tr
                    key={id}
                    ref={(element) => {
                      if (element) rowRefs.current.set(id, element);
                      else rowRefs.current.delete(id);
                    }}
                    tabIndex={id === focusableRowId ? 0 : -1}
                    className={cx(
                      "hb-table__row",
                      onRowActivate && "hb-table__row--actionable",
                      selectedRowId === id && "hb-table__row--selected",
                    )}
                    aria-current={selectedRowId === id ? "true" : undefined}
                    onKeyDown={(event) => onRowKeyDown(event, index, row)}
                    onClick={(event) => onRowClick(event, id, row)}
                    onFocus={(event) => {
                      if (event.target === event.currentTarget) setActiveRowId(id);
                    }}
                  >
                    {columns.map((column) => {
                      const cellClass = cx(
                        "hb-table__td",
                        column.align === "end" && "hb-table__cell--end",
                      );
                      return column.rowHeader ? (
                        <th key={column.id} scope="row" className={cellClass}>
                          {column.cell(row)}
                        </th>
                      ) : (
                        <td key={column.id} className={cellClass}>
                          {column.cell(row)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
