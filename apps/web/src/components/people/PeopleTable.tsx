"use client";

import { DataTable, type DataTableColumn, EmptyState } from "@harbour/ui";
import { Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { PersonListItem } from "@/lib/people";
import { AllergyChip } from "./AllergyChip";
import { CommunicationFlag } from "./CommunicationFlag";
import { PersonAvatar } from "./PersonAvatar";

export interface PeopleTableLabels {
  readonly caption: string;
  readonly photo: string;
  readonly name: string;
  readonly room: string;
  readonly dateOfBirth: string;
  readonly allergies: string;
  readonly communication: string;
  readonly communicationFlag: string;
  readonly notRecorded: string;
  readonly none: string;
  readonly empty: string;
}

/**
 * People in scope with the point-of-care essentials: photo, preferred and full name, room,
 * allergies and communication needs. Enter or a click on a row opens the person.
 */
export function PeopleTable({
  people,
  labels,
  showLocation,
}: {
  readonly people: readonly PersonListItem[];
  readonly labels: PeopleTableLabels;
  readonly showLocation: boolean;
}) {
  const router = useRouter();

  const columns: DataTableColumn<PersonListItem>[] = [
    {
      id: "photo",
      header: labels.photo,
      width: "4.5rem",
      cell: (person) => (
        <PersonAvatar
          personId={person.id}
          initials={person.initials}
          hasPhoto={person.hasPhoto}
          alt=""
        />
      ),
    },
    {
      id: "name",
      header: labels.name,
      rowHeader: true,
      sortValue: (person) => person.sortName,
      cell: (person) => (
        <span className="flex flex-col">
          <Link href={`/people/${person.id}`} className="font-semibold text-link">
            {person.hasPreferred ? person.preferred : person.full}
          </Link>
          {person.hasPreferred ? (
            <span className="text-callout font-normal text-text-secondary">{person.full}</span>
          ) : null}
        </span>
      ),
    },
    {
      id: "room",
      header: labels.room,
      sortValue: (person) => person.room,
      cell: (person) => (
        <span className="flex flex-col">
          <span>{person.room ?? labels.notRecorded}</span>
          {showLocation && person.locationName ? (
            <span className="text-callout text-text-secondary">{person.locationName}</span>
          ) : null}
        </span>
      ),
    },
    {
      id: "dateOfBirth",
      header: labels.dateOfBirth,
      sortValue: (person) => person.dateOfBirthIso,
      cell: (person) =>
        person.dateOfBirth && person.dateOfBirthIso ? (
          <time dateTime={person.dateOfBirthIso}>{person.dateOfBirth}</time>
        ) : (
          labels.notRecorded
        ),
    },
    {
      id: "allergies",
      header: labels.allergies,
      cell: (person) => <AllergyChip summary={person.allergy} />,
    },
    {
      id: "communication",
      header: labels.communication,
      cell: (person) =>
        person.communicationNeeds.length > 0 ? (
          <CommunicationFlag
            label={labels.communicationFlag}
            needs={person.communicationNeeds}
            compact
          />
        ) : (
          <span className="text-text-secondary">{labels.none}</span>
        ),
    },
  ];

  return (
    <DataTable
      caption={labels.caption}
      hideCaption
      columns={columns}
      rows={people}
      getRowId={(person) => person.id}
      defaultSort={{ columnId: "name", direction: "ascending" }}
      onRowActivate={(person) => router.push(`/people/${person.id}`)}
      emptyState={
        <EmptyState
          title={labels.empty}
          icon={<Users size={32} strokeWidth={1.5} aria-hidden="true" />}
          headingLevel={2}
        />
      }
    />
  );
}
