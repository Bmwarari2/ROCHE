/**
 * Invented people for stories and tests. No real personal data: names are placeholders and NHS
 * numbers come from the 999 test range.
 */

import type { ClinicalStatus } from "../tokens/tokens";

export interface ResidentFixture {
  id: string;
  name: string;
  preferredName: string;
  room: number;
  dateOfBirth: string;
  dateOfBirthLabel: string;
  nhsNumber: string;
  keyWorker: string;
  nextMedicines: string;
  medicinesStatus: ClinicalStatus;
}

export const residents: readonly ResidentFixture[] = [
  {
    id: "res-01",
    name: "Ada Example",
    preferredName: "Ada",
    room: 12,
    dateOfBirth: "1938-04-02",
    dateOfBirthLabel: "02/04/1938",
    nhsNumber: "999 000 0018",
    keyWorker: "Ben Sample",
    nextMedicines: "08:00",
    medicinesStatus: "overdue",
  },
  {
    id: "res-02",
    name: "Clive Placeholder",
    preferredName: "Clive",
    room: 3,
    dateOfBirth: "1941-11-19",
    dateOfBirthLabel: "19/11/1941",
    nhsNumber: "999 000 0026",
    keyWorker: "Dina Testcase",
    nextMedicines: "12:30",
    medicinesStatus: "due",
  },
  {
    id: "res-03",
    name: "Edith Specimen",
    preferredName: "Edie",
    room: 27,
    dateOfBirth: "1935-07-30",
    dateOfBirthLabel: "30/07/1935",
    nhsNumber: "999 000 0034",
    keyWorker: "Ben Sample",
    nextMedicines: "08:00",
    medicinesStatus: "done",
  },
  {
    id: "res-04",
    name: "Frank Dummy",
    preferredName: "Frank",
    room: 8,
    dateOfBirth: "1944-01-15",
    dateOfBirthLabel: "15/01/1944",
    nhsNumber: "999 000 0042",
    keyWorker: "Gita Mockup",
    nextMedicines: "Not prescribed",
    medicinesStatus: "notApplicable",
  },
  {
    id: "res-05",
    name: "Hilda Fixture",
    preferredName: "Hilda",
    room: 15,
    dateOfBirth: "1932-09-05",
    dateOfBirthLabel: "05/09/1932",
    nhsNumber: "999 000 0050",
    keyWorker: "Dina Testcase",
    nextMedicines: "14:00",
    medicinesStatus: "due",
  },
  {
    id: "res-06",
    name: "Ivor Instance",
    preferredName: "Ivor",
    room: 21,
    dateOfBirth: "1947-03-23",
    dateOfBirthLabel: "23/03/1947",
    nhsNumber: "999 000 0069",
    keyWorker: "Gita Mockup",
    nextMedicines: "08:00",
    medicinesStatus: "done",
  },
];
