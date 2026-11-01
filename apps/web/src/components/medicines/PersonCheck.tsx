import type { PersonSummary } from "@harbour/contracts";
import { AllergyChip } from "@/components/people/AllergyChip";
import { formatDate, formatNhsNumber } from "@/lib/format";
import { t } from "@/lib/i18n";
import { allergySummary, personNames } from "@/lib/people";

type Person = Pick<
  PersonSummary,
  | "givenName"
  | "familyName"
  | "preferredName"
  | "dateOfBirth"
  | "nhsNumber"
  | "allergyStatus"
  | "allergies"
>;

const SEVERITY_ORDER = ["life_threatening", "severe", "moderate", "mild"];
const rank = (severity: string) => {
  const i = SEVERITY_ORDER.indexOf(severity);
  return i === -1 ? SEVERITY_ORDER.length : i;
};

/**
 * Who the medicine is for and every allergy, shown beside each medicine form (medicines.md section
 * 13; HZ-001, HZ-007): the person's name, date of birth and NHS number, the allergy status, and each
 * allergy's substance, severity and reaction, most severe first, so the person recording compares
 * them with the source and the product here, not in the header far above. Harbour never matches
 * them.
 */
export function PersonCheck({ person }: { readonly person: Person }) {
  const born = formatDate(person.dateOfBirth) ?? t("medicines.person.noBirthDate");
  const allergies = [...person.allergies].sort((a, b) => rank(a.severity) - rank(b.severity));
  return (
    <section
      className="flex flex-col gap-2 rounded-input border border-border p-3"
      aria-label={t("medicines.person.label")}
    >
      <p className="m-0 font-semibold">
        {t("medicines.person.for", { name: personNames(person).full, born })}
      </p>
      {person.nhsNumber ? (
        <p className="m-0 text-body-dense">
          {t("medicines.person.nhs", { nhs: formatNhsNumber(person.nhsNumber) ?? "" })}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-body-dense font-semibold">{t("medicines.person.allergies")}</span>
        <AllergyChip summary={allergySummary(person, t)} />
      </div>
      {allergies.length > 0 ? (
        <ul className="m-0 flex flex-col gap-1 pl-5">
          {allergies.map((a) => (
            <li key={`${a.substance}-${a.severity}`}>
              <span className="font-semibold">{a.substance}</span>
              {", "}
              {a.reaction
                ? t("people.header.allergyReaction", {
                    severity: t("people.header.allergySeverity", { severity: a.severity }),
                    reaction: a.reaction,
                  })
                : t("people.header.allergySeverity", { severity: a.severity })}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="m-0 text-body-dense">{t("medicines.person.compare")}</p>
    </section>
  );
}
