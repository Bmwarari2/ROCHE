/**
 * Medical examiner information pack (safety.md section 4 rule 8; SAFE-008). Every death of a person
 * using the service generates the pack the medical examiner office may ask for. Since 9 September
 * 2024 every death in England and Wales is scrutinised by a medical examiner or investigated by a
 * coroner (DHSC, "An overview of the death certification reforms"; the Medical Examiners (England)
 * Regulations 2024, SI 2024/493). The provider supplies information; it does not certify anything.
 * The API assembles each section from its module; nothing is generated or summarised by AI.
 */

import { type Citation, cite, SOURCES } from "../shared/citation";

export const MEDICAL_EXAMINER_PACK_SECTIONS = [
  {
    key: "demographics",
    title: "Demographics",
    contents: "Name, date of birth, NHS number, address, GP practice and next of kin",
    module: "people",
  },
  {
    key: "diagnoses",
    title: "Diagnoses and conditions",
    contents: "Recorded diagnoses, conditions and allergies",
    module: "people",
  },
  {
    key: "recent_notes",
    title: "Recent care notes",
    contents: "Daily notes before the death, with their recorded times and late-entry flags",
    module: "care",
  },
  {
    key: "recent_observations",
    title: "Recent observations",
    contents: "Observations and validated tool results before the death, with the workings",
    module: "care",
  },
  {
    key: "medicines",
    title: "Medicines",
    contents: "Current medicines and recent administrations",
    module: "medicines",
  },
  {
    key: "advance_care_records",
    title: "Advance care records",
    contents:
      "ReSPECT, DNACPR, advance decision to refuse treatment and advance care plan, with review dates",
    module: "care",
  },
  {
    key: "death_circumstances",
    title: "Circumstances of the death",
    contents: "Who was present, the time of death and how it was confirmed",
    module: "safety",
  },
] as const;

export type MedicalExaminerPackSection = (typeof MEDICAL_EXAMINER_PACK_SECTIONS)[number]["key"];

export const MEDICAL_EXAMINER_SOURCES: readonly Citation[] = [
  cite("DHSC", "An overview of the death certification reforms", SOURCES.deathCertification),
  cite(
    "Medical Examiners (England) Regulations 2024",
    "SI 2024/493",
    SOURCES.medicalExaminersEngland,
  ),
  cite("Harbour master prompt", "11.1 (deaths)", "docs/00-MASTER-PROMPT.md"),
];

/** The sections still to assemble, in pack order. */
export function missingPackSections(
  assembled: readonly MedicalExaminerPackSection[],
): MedicalExaminerPackSection[] {
  return MEDICAL_EXAMINER_PACK_SECTIONS.map((s) => s.key).filter((k) => !assembled.includes(k));
}
