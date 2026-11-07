"use client";

import { DataTable, type DataTableColumn } from "@harbour/ui";
import type { ReactNode } from "react";

export interface OrderLineRow {
  readonly id: string;
  /** The person's name with their communication needs (AIS). */
  readonly person: ReactNode;
  readonly medicine: string;
  readonly ordered: string;
  readonly received: string;
}

/**
 * An order's lines (slice 55; medicines.md section 15): a captioned table whose first column names
 * the person each line is for, with the quantities in their own cells (accessibility review).
 */
export function OrderLinesTable({
  caption,
  headers,
  rows,
  empty,
}: {
  readonly caption: string;
  readonly headers: { person: string; medicine: string; ordered: string; received: string };
  readonly rows: readonly OrderLineRow[];
  readonly empty: string;
}) {
  const columns: DataTableColumn<OrderLineRow>[] = [
    { id: "person", header: headers.person, rowHeader: true, cell: (row) => row.person },
    { id: "medicine", header: headers.medicine, cell: (row) => row.medicine },
    { id: "ordered", header: headers.ordered, align: "end", cell: (row) => row.ordered },
    { id: "received", header: headers.received, align: "end", cell: (row) => row.received },
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
