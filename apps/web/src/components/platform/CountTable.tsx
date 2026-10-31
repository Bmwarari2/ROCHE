"use client";

import { DataTable, type DataTableColumn } from "@harbour/ui";

export interface CountColumn {
  readonly id: string;
  readonly header: string;
  /** Numbers sit at the end of the cell. */
  readonly numeric?: boolean;
}

export interface CountRow {
  readonly id: string;
  /** Each column's words or number, by column id; the first column names the row. */
  readonly cells: Readonly<Record<string, string | number>>;
}

/**
 * A small table of counts for a report (the weekly break-glass report's lines by member of staff,
 * person and reason), from words the page has already put together: server pages cannot hand
 * DataTable its cell functions. Rows keep the report's order (most first) and sort by any column.
 */
export function CountTable({
  caption,
  columns,
  rows,
}: {
  readonly caption: string;
  readonly columns: readonly CountColumn[];
  readonly rows: readonly CountRow[];
}) {
  const tableColumns: DataTableColumn<CountRow>[] = columns.map((column, index) => ({
    id: column.id,
    header: column.header,
    cell: (row) => row.cells[column.id] ?? "",
    sortValue: (row) => row.cells[column.id],
    ...(column.numeric ? { align: "end" as const } : {}),
    ...(index === 0 ? { rowHeader: true } : {}),
  }));
  return (
    <DataTable
      caption={caption}
      columns={tableColumns}
      rows={rows}
      getRowId={(row) => row.id}
      showDensityToggle={false}
    />
  );
}
