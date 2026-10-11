import type { PersonCareProfile, PersonSummary } from "@harbour/contracts";
import { Card } from "@harbour/ui";
import type { ReactNode } from "react";
import { ResuscitationStatus } from "@/components/care/ResuscitationStatus";
import { iddsiLabel } from "@/lib/care-record";
import { formatDate, formatNhsNumber } from "@/lib/format";
import { t } from "@/lib/i18n";
import { allergySummary, initials, personNames, roomLabel } from "@/lib/people";
import { AllergyChip } from "./AllergyChip";
import { CommunicationFlag } from "./CommunicationFlag";
import { PersonAvatar } from "./PersonAvatar";

function Detail({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-callout text-text-secondary">{term}</dt>
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

/**
 * The point-of-care header (section 9, hazards HZ-001, HZ-007, HZ-015 and HZ-016): photo,
 * preferred and full name, NHS number, date of birth, allergies, the resuscitation decision in
 * force, the prescribed IDDSI levels and communication needs, so the right person and what keeps
 * them safe are always in view. It sits above every tab of the record.
 */
export function PersonHeader({
  person,
  locationName,
  careProfile = null,
}: {
  readonly person: PersonSummary;
  readonly locationName: string | null;
  /** IDDSI levels; null when the person viewing may not read the care profile. */
  readonly careProfile?: PersonCareProfile | null;
}) {
  const names = personNames(person);
  const allergy = allergySummary(person, t);
  const room = roomLabel(person);
  const roomText = room ? t("people.header.room", { room }) : null;
  const dateOfBirth = formatDate(person.dateOfBirth);
  const nhsNumber = formatNhsNumber(person.nhsNumber);
  const needs = person.communicationNeeds;

  return (
    <Card as="section" aria-label={t("people.header.label")}>
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-4">
          <PersonAvatar
            personId={person.id}
            initials={initials(person)}
            hasPhoto={person.photoUrl !== null}
            alt={t("people.header.photo", { name: names.full })}
            size="large"
          />
          <div className="flex min-w-0 flex-col">
            {locationName ? (
              <p className="m-0 text-callout text-text-secondary">
                {roomText
                  ? t("people.header.locationAndRoom", { location: locationName, room: roomText })
                  : locationName}
              </p>
            ) : null}
            <h1 className="m-0 text-title">{names.hasPreferred ? names.preferred : names.full}</h1>
            {names.hasPreferred ? (
              <p className="m-0 text-body text-text-secondary">{names.full}</p>
            ) : null}
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
          {careProfile ? (
            <>
              <Detail term={t("care.header.iddsiFood")}>
                {iddsiLabel("food", careProfile.iddsiFoodLevel, t)}
              </Detail>
              <Detail term={t("care.header.iddsiDrink")}>
                {iddsiLabel("drink", careProfile.iddsiDrinkLevel, t)}
              </Detail>
            </>
          ) : null}
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
          {needs.length > 0 ? (
            <>
              <CommunicationFlag
                label={t("people.header.communicationNeeds")}
                needs={needs.map((n) => n.display)}
              />
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {needs.map((need) => (
                  <li key={need.code} className="rounded-input border border-border px-4 py-2">
                    <span className="font-semibold">{need.display}</span>
                    {need.preferredFormat ? (
                      <span className="text-text-secondary">
                        , {t("people.header.preferredFormat", { format: need.preferredFormat })}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="m-0 text-text-secondary">{t("people.header.communicationNeedsNone")}</p>
          )}
        </section>
      </div>
    </Card>
  );
}
