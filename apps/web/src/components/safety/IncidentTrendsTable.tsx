"use client";

import { DataTable, type DataTableColumn } from "@harbour/ui";

export interface TrendTableRow {
  readonly id: string;
  readonly label: string;
  /** Each month's count in words ("4", or "500 or more" for a month cut at the API's limit). */
  readonly cells: readonly string[];
  readonly total: string;
}

/**
 * Incidents by type and month as a table (SAFE-010): the type names each row, counts are numbers
 * in tabular figures, and the last row gives the totals. The words come from the page.
 */
export function IncidentTrendsTable({
  caption,
  typeHeader,
  totalHeader,
  months,
  rows,
}: {
  readonly caption: string;
  readonly typeHeader: string;
  readonly totalHeader: string;
  /** Each month's heading, oldest first. */
  readonly months: readonly string[];
  readonly rows: readonly TrendTableRow[];
}) {
  const columns: DataTableColumn<TrendTableRow>[] = [
    { id: "type", header: typeHeader, rowHeader: true, cell: (row) => row.label },
    ...months.map((header, i) => ({
      id: `month-${i}`,
      header,
      align: "end" as const,
      cell: (row: TrendTableRow) => row.cells[i] ?? "",
    })),
    { id: "total", header: totalHeader, align: "end", cell: (row) => row.total },
  ];
  return (
    <DataTable
      caption={caption}
      columns={columns}
      rows={rows}
      getRowId={(row) => row.id}
      showDensityToggle={false}
    />
  );
}
