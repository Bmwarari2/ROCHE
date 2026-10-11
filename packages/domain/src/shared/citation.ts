/**
 * Where a rule comes from. Every regulatory rule in the domain package names its source so the
 * screen can show it and a reviewer can check it (section 5.2; docs/specs/rates.md for figures).
 * The URL is the page that was read when the rule was written; `provision` is the paragraph.
 */

export interface Citation {
  /** Short name, for example "CQC (Registration) Regulations 2009". */
  readonly source: string;
  /** The paragraph or section, for example "reg 18(2)(a)". */
  readonly provision: string;
  readonly url: string;
}

export function cite(source: string, provision: string, url: string): Citation {
  return { source, provision, url };
}

/** "CQC (Registration) Regulations 2009 reg 18(2)(a)" for reasoning lines and the audit trail. */
export function citationText(citation: Citation): string {
  return `${citation.source} ${citation.provision}`;
}

/** Pages read on 11 October 2026 (legislation.gov.uk, gov.uk, hse.gov.uk, nice.org.uk). */
export const SOURCES = {
  cqcRegistrationRegs: "https://www.legislation.gov.uk/uksi/2009/3112",
  cqcReg16: "https://www.legislation.gov.uk/uksi/2009/3112/regulation/16",
  cqcReg17: "https://www.legislation.gov.uk/uksi/2009/3112/regulation/17",
  cqcReg18: "https://www.legislation.gov.uk/uksi/2009/3112/regulation/18",
  cqcNotifications: "https://www.cqc.org.uk/guidance-regulation/providers/notifications",
  cqcPoliceForm:
    "https://www.cqc.org.uk/guidance-regulation/notifications/police-involvement-incident-notification-form",
  cqcDolsForm:
    "https://www.cqc.org.uk/guidance-regulation/notifications/application-deprive-person-their-liberty-dols-notification-form",
  cqcAbsenceForm:
    "https://www.cqc.org.uk/guidance-regulation/registration/unauthorised-absence-notification-form",
  candourReg20: "https://www.legislation.gov.uk/uksi/2014/2936/regulation/20",
  riddor: "https://www.legislation.gov.uk/uksi/2013/1471",
  riddorReg2: "https://www.legislation.gov.uk/uksi/2013/1471/regulation/2",
  riddorReg4: "https://www.legislation.gov.uk/uksi/2013/1471/regulation/4",
  riddorReg5: "https://www.legislation.gov.uk/uksi/2013/1471/regulation/5",
  riddorReg6: "https://www.legislation.gov.uk/uksi/2013/1471/regulation/6",
  riddorSchedule1: "https://www.legislation.gov.uk/uksi/2013/1471/schedule/1",
  riddorSchedule2: "https://www.legislation.gov.uk/uksi/2013/1471/schedule/2",
  hseWhenToReport: "https://www.hse.gov.uk/riddor/when-do-i-report.htm",
  hseHealthAndSocialCare: "https://www.hse.gov.uk/pubns/hsis1.pdf",
  careActS42: "https://www.legislation.gov.uk/ukpga/2014/23/section/42",
  careStatutoryGuidance:
    "https://www.gov.uk/government/publications/care-act-statutory-guidance/care-and-support-statutory-guidance",
  pressureUlcerProtocol:
    "https://www.gov.uk/government/publications/pressure-ulcers-how-to-safeguard-adults/safeguarding-adults-protocol-pressure-ulcers-and-raising-a-safeguarding-concern",
  leder: "https://leder.nhs.uk/report",
  ukhsaAri:
    "https://www.gov.uk/guidance/report-an-outbreak-of-acute-respiratory-infection-in-an-adult-social-care-setting",
  deathCertification:
    "https://www.gov.uk/government/publications/changes-to-the-death-certification-process/an-overview-of-the-death-certification-reforms",
  medicalExaminersEngland: "https://www.legislation.gov.uk/uksi/2024/493",
  niceNg232: "https://www.nice.org.uk/guidance/ng232/chapter/Recommendations",
  niceNg249: "https://www.nice.org.uk/guidance/ng249",
  mca: "https://www.legislation.gov.uk/ukpga/2005/9",
  mcaS1: "https://www.legislation.gov.uk/ukpga/2005/9/section/1",
  mcaS2: "https://www.legislation.gov.uk/ukpga/2005/9/section/2",
  mcaS3: "https://www.legislation.gov.uk/ukpga/2005/9/section/3",
  mcaS4: "https://www.legislation.gov.uk/ukpga/2005/9/section/4",
  mcaS9: "https://www.legislation.gov.uk/ukpga/2005/9/section/9",
  mcaS11: "https://www.legislation.gov.uk/ukpga/2005/9/section/11",
  mcaS20: "https://www.legislation.gov.uk/ukpga/2005/9/section/20",
  mcaS37: "https://www.legislation.gov.uk/ukpga/2005/9/section/37",
  mcaS38: "https://www.legislation.gov.uk/ukpga/2005/9/section/38",
  mcaS39: "https://www.legislation.gov.uk/ukpga/2005/9/section/39",
  mcaScheduleA1: "https://www.legislation.gov.uk/ukpga/2005/9/schedule/A1",
  dhscDolsGuidance:
    "https://www.gov.uk/government/publications/changes-to-the-definition-of-deprivation-of-liberty/uk-supreme-court-2026-judgment-on-what-constitutes-a-deprivation-of-liberty",
  supremeCourtDol2026: "https://supremecourt.uk/cases/uksc-2025-0042",
} as const;
