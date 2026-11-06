"use client";

import { DataTable, type DataTableColumn } from "@harbour/ui";
import type { TableRow } from "@/lib/medication-errors";

/**
 * A medicines report as a table (slice 55; medicines.md section 14.3): the first column names each
 * row, every count is a number in its own cell, and the words come from the page. Nothing is shown
 * by colour, so the report reads the same printed, zoomed or with a screen reader.
 */
export function ReportTable({
  caption,
  rowHeader,
  headers,
  rows,
  empty,
}: {
  readonly caption: string;
  readonly rowHeader: string;
  /** One heading per count column, in the order of each row's cells. */
  readonly headers: readonly string[];
  readonly rows: readonly TableRow[];
  readonly empty: string;
}) {
  const columns: DataTableColumn<TableRow>[] = [
    { id: "label", header: rowHeader, rowHeader: true, cell: (row) => row.label },
    ...headers.map((header, i) => ({
      id: `count-${i}`,
      header,
      align: "end" as const,
      cell: (row: TableRow) => row.cells[i] ?? "",
    })),
  ];
  return (
    <DataTable
      caption={caption}
      columns={columns}
      rows={rows}
      getRowId={(row) => row.id}
      showDensityToggle={false}
      emptyState={<p className="m-0">{empty}</p>}
    />
  );
}
