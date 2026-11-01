import type { PersonSummary } from "@harbour/contracts";
import { AllergyChip } from "@/components/people/AllergyChip";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { allergySummary, personNames } from "@/lib/people";

/**
 * Who the medicine is for and their allergies, shown beside every medicine form (medicines.md
 * section 13): the person's name, date of birth and NHS number, and the allergy chip, for the
 * person recording to compare with the source and the product. Harbour never matches them.
 */
export function PersonCheck({
  person,
}: {
  readonly person: Pick<
    PersonSummary,
    | "givenName"
    | "familyName"
    | "preferredName"
    | "dateOfBirth"
    | "nhsNumber"
    | "allergyStatus"
    | "allergies"
  >;
}) {
  const born = formatDate(person.dateOfBirth) ?? t("medicines.person.noBirthDate");
  return (
    <div className="flex flex-col gap-2 rounded-input border border-border p-3" role="note">
      <p className="m-0 font-semibold">
        {t("medicines.person.for", { name: personNames(person).full, born })}
      </p>
      {person.nhsNumber ? (
        <p className="m-0 text-body-dense">
          {t("medicines.person.nhs", { nhs: person.nhsNumber })}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-body-dense font-semibold">{t("medicines.person.allergies")}</span>
        <AllergyChip summary={allergySummary(person, t)} />
      </div>
      <p className="m-0 text-body-dense">{t("medicines.person.compare")}</p>
    </div>
  );
}
