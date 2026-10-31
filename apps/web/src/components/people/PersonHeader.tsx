import type { PersonSummary } from "@harbour/contracts";
import { Card, StatusChip } from "@harbour/ui";
import { Lock, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { HeaderFreshness } from "@/components/care/HeaderFreshness";
import { ResuscitationStatus } from "@/components/care/ResuscitationStatus";
import { PersonStatusBadge } from "@/components/exit/ExitChip";
import { iddsiLabel } from "@/lib/care-record";
import { formatDate, formatNhsNumber } from "@/lib/format";
import { t } from "@/lib/i18n";
import {
  allergySummary,
  communicationSummary,
  initials,
  personNames,
  roomLabel,
} from "@/lib/people";
import type { CareProfileLoad, PersonRecord } from "@/lib/record-data";
import { AllergyChip } from "./AllergyChip";
import { CommunicationFlag } from "./CommunicationFlag";
import { CommunicationStatus } from "./CommunicationStatus";
import { PersonAvatar } from "./PersonAvatar";
import { SampleBadge } from "./SampleBadge";

function Detail({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-body-dense text-text-secondary">{term}</dt>
      <dd className="m-0 font-semibold">{children}</dd>
    </div>
  );
}

/** "Severe", or "Severe: Rash" when a reaction is recorded. Unknown severities show as recorded. */
function allergyDetail(allergy: PersonSummary["allergies"][number]): string {
  const severity = t("people.header.allergySeverity", { severity: allergy.severity });
  return allergy.reaction
    ? t("people.header.allergyReaction", { severity, reaction: allergy.reaction })
    : severity;
}

/** An IDDSI level, or why it cannot be shown: never left out without saying so (HZ-016). */
function IddsiDetail({
  kind,
  careProfile,
}: {
  readonly kind: "food" | "drink";
  readonly careProfile: CareProfileLoad;
}) {
  switch (careProfile.kind) {
    case "ok":
      return iddsiLabel(
        kind,
        kind === "food" ? careProfile.profile.iddsiFoodLevel : careProfile.profile.iddsiDrinkLevel,
        t,
      );
    case "no_access":
      return <StatusChip status="neutral" label={t("care.header.iddsiNoAccess")} icon={Lock} />;
    case "unreadable":
      return (
        <StatusChip
          status="overdue"
          label={t("care.header.iddsiUnreadable")}
          icon={TriangleAlert}
        />
      );
  }
}

/**
 * The point-of-care header (section 9, hazards HZ-001, HZ-002, HZ-007, HZ-015 and HZ-016): photo,
 * preferred and full name, NHS number, date of birth, allergies, the resuscitation decision in
 * force, the prescribed IDDSI levels and communication needs, so the right person and what keeps
 * them safe are always in view. Every tab of the record reads it again; it says when it was read
 * and can be read again at once.
 */
export function PersonHeader({
  person,
  locationName,
  careProfile,
  checkedAt,
  checkedLabel,
}: {
  readonly person: PersonRecord;
  readonly locationName: string | null;
  /** IDDSI levels, or why they cannot be shown. */
  readonly careProfile: CareProfileLoad;
  /** When the header was read (ISO), and the time in UK words ("14:05"). */
  readonly checkedAt: string;
  readonly checkedLabel: string;
}) {
  const names = personNames(person);
  const allergy = allergySummary(person, t);
  const room = roomLabel(person);
  const roomText = room ? t("people.header.room", { room }) : null;
  const dateOfBirth = formatDate(person.dateOfBirth);
  const nhsNumber = formatNhsNumber(person.nhsNumber);
  const needs = person.communicationNeeds;
  const communication = communicationSummary(person, t);

  return (
    <Card as="section" aria-label={t("people.header.label")}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-4">
          <PersonAvatar
            personId={person.id}
            initials={initials(person)}
            hasPhoto={person.photoUrl !== null}
            alt={t("people.header.photo", { name: names.full })}
            size="large"
          />
          <div className="flex min-w-0 flex-col">
            {locationName ? (
              <p className="m-0 text-body-dense text-text-secondary">
                {roomText
                  ? t("people.header.locationAndRoom", { location: locationName, room: roomText })
                  : locationName}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="m-0 text-title">
                {names.hasPreferred ? names.preferred : names.full}
              </h1>
              <SampleBadge sample={person.sample} />
              <PersonStatusBadge status={person.status} />
            </div>
            {names.hasPreferred ? (
              <p className="m-0 text-body text-text-secondary">{names.full}</p>
            ) : null}
          </div>
          <div className="ms-auto">
            <HeaderFreshness checkedAt={checkedAt} checkedLabel={checkedLabel} />
          </div>
        </div>

        <dl className="m-0 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Detail term={t("people.header.nhsNumber")}>
            {nhsNumber ? (
              <span className="tabular-nums">{nhsNumber}</span>
            ) : (
              t("common.notRecorded")
            )}
          </Detail>
          <Detail term={t("people.header.dateOfBirth")}>
            {dateOfBirth && person.dateOfBirth ? (
              <time dateTime={person.dateOfBirth} className="tabular-nums">
                {dateOfBirth}
              </time>
            ) : (
              t("common.notRecorded")
            )}
          </Detail>
          <Detail term={t("people.header.allergiesTitle")}>
            <AllergyChip summary={allergy} />
          </Detail>
          <Detail term={t("care.header.resuscitation")}>
            <ResuscitationStatus status={person.resuscitation} />
          </Detail>
          <Detail term={t("care.header.iddsiFood")}>
            <IddsiDetail kind="food" careProfile={careProfile} />
          </Detail>
          <Detail term={t("care.header.iddsiDrink")}>
            <IddsiDetail kind="drink" careProfile={careProfile} />
          </Detail>
        </dl>

        {person.allergies.length > 0 ? (
          <section aria-labelledby="allergies-heading" className="flex flex-col gap-2">
            <h2 id="allergies-heading" className="m-0 text-body font-semibold">
              {t("people.header.allergiesTitle")}
            </h2>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {person.allergies.map((a) => (
                <li
                  key={`${a.substance}-${a.severity}`}
                  className="rounded-input border border-border px-4 py-2"
                >
                  <span className="font-semibold">{a.substance}</span>
                  <span className="text-text-secondary">, {allergyDetail(a)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section aria-labelledby="communication-heading" className="flex flex-col gap-2">
          <h2 id="communication-heading" className="m-0 text-body font-semibold">
            {t("people.header.communicationNeeds")}
          </h2>
          {communication.kind === "recorded" ? (
            <>
              <CommunicationFlag
                label={t("people.header.communicationNeeds")}
                needs={communication.needs}
              />
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {needs.map((need) => (
                  <li key={need.code} className="rounded-input border border-border px-4 py-2">
                    <span className="font-semibold">{need.display}</span>
                    {need.preferredFormat ? (
                      <span className="text-text-secondary">
                        {", "}
                        {t("people.communication.preferredFormat", {
                          format: need.preferredFormat,
                        })}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="m-0">
              <CommunicationStatus
                summary={communication}
                flagLabel={t("people.header.communicationNeeds")}
              />
            </p>
          )}
        </section>
      </div>
    </Card>
  );
}

/** A prescribed IDDSI level from the point-of-care header, never blank (HZ-016). */
function iddsiWords(kind: "food" | "drink", level: string): string {
  return level === "not_recorded"
    ? t("care.header.iddsiNotRecorded", { kind })
    : iddsiLabel(kind, level, t);
}

/**
 * The point-of-care header in its compact form, for a person among others on a list where care is
 * recorded (a round stop, a handover group; HZ-001, HZ-007, HZ-015, HZ-016): photo, name as a
 * heading linking to the record, room, allergies, the resuscitation decision in force, the
 * prescribed IDDSI levels and communication needs, each labelled in every state.
 */
export function PersonHeaderCompact({
  person,
  headingLevel = 3,
}: {
  readonly person: PersonSummary;
  readonly headingLevel?: 2 | 3 | 4;
}) {
  const names = personNames(person);
  const room = roomLabel(person);
  const Heading = `h${headingLevel}` as const;
  return (
    <div className="flex flex-col gap-2" data-person-header="compact">
      <div className="flex flex-wrap items-center gap-3">
        <PersonAvatar
          personId={person.id}
          initials={initials(person)}
          hasPhoto={person.photoUrl !== null}
          alt={t("people.header.photo", { name: names.full })}
        />
        <Heading className="m-0 text-body font-semibold">
          <a
            href={`/people/${person.id}`}
            className="inline-flex min-h-target items-center underline"
          >
            {room ? t("people.header.nameAndRoom", { name: names.full, room }) : names.full}
          </a>
        </Heading>
        <SampleBadge sample={person.sample} />
        <PersonStatusBadge status={person.status} />
      </div>
      <dl className="m-0 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Detail term={t("people.header.allergiesTitle")}>
          <AllergyChip summary={allergySummary(person, t)} />
        </Detail>
        <Detail term={t("care.header.resuscitation")}>
          <ResuscitationStatus status={person.resuscitation} />
        </Detail>
        <Detail term={t("care.header.iddsiFood")}>
          {iddsiWords("food", person.iddsiFoodLevel)}
        </Detail>
        <Detail term={t("care.header.iddsiDrink")}>
          {iddsiWords("drink", person.iddsiDrinkLevel)}
        </Detail>
        <Detail term={t("people.header.communicationNeeds")}>
          <CommunicationStatus
            summary={communicationSummary(person, t)}
            flagLabel={t("people.header.communicationNeeds")}
            compact
          />
        </Detail>
      </dl>
    </div>
  );
}
