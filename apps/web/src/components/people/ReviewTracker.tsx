"use client";

import { DataTable, type DataTableColumn, EmptyState } from "@harbour/ui";
import { CircleCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { CommunicationSummary } from "@/lib/people";
import { CommunicationStatus } from "./CommunicationStatus";

/** One review due, already in words: the table only lays it out. */
export interface TrackerTableRow {
  readonly id: string;
  readonly personId: string;
  readonly name: string;
  readonly review: string;
  readonly dueOn: string;
  readonly dueLabel: string;
  readonly location: string | null;
  readonly chip: ReactNode;
  /** The person's communication needs, shown wherever they are named (AIS; HZ-023). */
  readonly communication: CommunicationSummary;
}

/**
 * Reviews due and overdue across a location (people.md section 6a; PEOP-008), overdue first. Each
 * person's name links to their reviews tab; the state is an icon and a word.
 */
export function ReviewTracker({
  rows,
  showLocation,
  labels,
}: {
  readonly rows: readonly TrackerTableRow[];
  readonly showLocation: boolean;
  readonly labels: {
    readonly caption: string;
    readonly person: string;
    readonly review: string;
    readonly due: string;
    readonly state: string;
    readonly location: string;
    readonly communication: string;
    readonly empty: string;
  };
}) {
  const columns: DataTableColumn<TrackerTableRow>[] = [
    {
      id: "person",
      header: labels.person,
      rowHeader: true,
      cell: (row) => (
        <Link
          href={`/people/${row.personId}/reviews`}
          className="inline-flex min-h-target items-center underline"
        >
          {row.name}
        </Link>
      ),
    },
    { id: "review", header: labels.review, cell: (row) => row.review },
    { id: "due", header: labels.due, sortValue: (row) => row.dueOn, cell: (row) => row.dueLabel },
    { id: "state", header: labels.state, cell: (row) => row.chip },
    {
      id: "communication",
      header: labels.communication,
      cell: (row) => (
        <CommunicationStatus summary={row.communication} flagLabel={labels.communication} compact />
      ),
    },
    ...(showLocation
      ? [{ id: "location", header: labels.location, cell: (row: TrackerTableRow) => row.location }]
      : []),
  ];
  return (
    <DataTable
      caption={labels.caption}
      hideCaption
      columns={columns}
      rows={rows}
      getRowId={(row) => row.id}
      emptyState={
        <EmptyState
          icon={<CircleCheck size={32} strokeWidth={1.5} aria-hidden="true" />}
          title={labels.empty}
        />
      }
    />
  );
}
