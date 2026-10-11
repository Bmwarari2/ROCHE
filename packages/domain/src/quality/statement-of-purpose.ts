import { defineWorkflow } from "../platform/workflow";
import { type Citation, cite } from "../shared/citation";
import { addUkDays } from "../shared/time";
import type { StatementOfPurposeRates } from "./rates";

/**
 * Statement of purpose (master prompt 11.2, registration and governance row: "statement of purpose
 * with change tracking"; quality.md section 4 rules 8 to 12).
 *
 * CQC (Registration) Regulations 2009, regulation 12: the registered person gives CQC a statement
 * of purpose containing the information in Schedule 3 (12(1)), keeps it under review (12(2)) and
 * provides written details of any revision within `cqc.statement_of_purpose.revision_notice_days`
 * days of the revision (12(3)). Read on legislation.gov.uk on 11 October 2026: Schedule 3 has five
 * paragraphs, paragraph 3 as substituted by S.I. 2012/921.
 */

const REG_12 = "https://www.legislation.gov.uk/uksi/2009/3112/regulation/12";
const SCHEDULE_3 = "https://www.legislation.gov.uk/uksi/2009/3112/schedule/3";
const HSCA_2008_S10 = "https://www.legislation.gov.uk/ukpga/2008/14/section/10";
const HSCA_2008_S14 = "https://www.legislation.gov.uk/ukpga/2008/14/section/14";
const HSCA_2008_S19 = "https://www.legislation.gov.uk/ukpga/2008/14/section/19";
const REGISTRATION_REGS = "CQC (Registration) Regulations 2009";
const HSCA_2008 = "Health and Social Care Act 2008";

export const STATEMENT_OF_PURPOSE_ITEM_KEYS = [
  "aims_and_objectives",
  "services_and_needs",
  "contact_details",
  "legal_status",
  "locations",
] as const;

export type StatementOfPurposeItemKey = (typeof STATEMENT_OF_PURPOSE_ITEM_KEYS)[number];

export interface StatementOfPurposeItemDefinition {
  readonly key: StatementOfPurposeItemKey;
  readonly title: string;
  /** The Schedule's words. */
  readonly wording: string;
  readonly citation: Citation;
}

/** Schedule 3, in the regulation's words. */
export const STATEMENT_OF_PURPOSE_ITEMS: readonly StatementOfPurposeItemDefinition[] = [
  {
    key: "aims_and_objectives",
    title: "Aims and objectives",
    wording:
      "The aims and objectives of the service provider in carrying on the regulated activity.",
    citation: cite(REGISTRATION_REGS, "Schedule 3 para 1", SCHEDULE_3),
  },
  {
    key: "services_and_needs",
    title: "Services and the needs they meet",
    wording:
      "The kinds of services provided for the purposes of the carrying on of the regulated activity and the range of service users' needs which those services are intended to meet.",
    citation: cite(REGISTRATION_REGS, "Schedule 3 para 2", SCHEDULE_3),
  },
  {
    key: "contact_details",
    title: "Names and contact details",
    wording:
      "In relation to the service provider and any registered manager: full name, business address, business telephone number, electronic mail address where available; in relation to the registered person: the address to which the Commission may send any document, notice or other communication, and, where the registered person consents to service by such means, an electronic mail address.",
    citation: cite(
      REGISTRATION_REGS,
      "Schedule 3 para 3 (substituted by S.I. 2012/921)",
      SCHEDULE_3,
    ),
  },
  {
    key: "legal_status",
    title: "Legal status",
    wording: "The legal status of the service provider.",
    citation: cite(REGISTRATION_REGS, "Schedule 3 para 4", SCHEDULE_3),
  },
  {
    key: "locations",
    title: "Locations",
    wording:
      "Details of the locations at which the services provided for the purposes of the regulated activity are carried on.",
    citation: cite(REGISTRATION_REGS, "Schedule 3 para 5", SCHEDULE_3),
  },
];

export const LEGAL_STATUSES = [
  "individual",
  "partnership",
  "limited_company",
  "limited_liability_partnership",
  "charitable_incorporated_organisation",
  "community_interest_company",
  "nhs_body",
  "local_authority",
  "other",
] as const;

export type LegalStatus = (typeof LEGAL_STATUSES)[number];

export interface BusinessContact {
  readonly fullName: string;
  readonly businessAddress: string;
  readonly businessPhone: string;
  /** "Where available". */
  readonly email: string | null;
}

export interface RegisteredManagerEntry extends BusinessContact {
  readonly id: string;
}

export interface StatementOfPurposeLocation {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly cqcLocationId: string | null;
}

export interface StatementOfPurposeContent {
  readonly aimsAndObjectives: string;
  /** Service types, for example "Care home service with nursing". */
  readonly serviceKinds: readonly string[];
  readonly needsMet: string;
  readonly provider: BusinessContact;
  readonly registeredManagers: readonly RegisteredManagerEntry[];
  readonly serviceAddress: string;
  readonly consentsToEmailService: boolean;
  readonly serviceEmail: string | null;
  readonly legalStatus: LegalStatus | null;
  /** Required when the legal status is `other`. */
  readonly legalStatusDetail: string | null;
  readonly locations: readonly StatementOfPurposeLocation[];
}

/** Why: a section needs at least a short sentence; a heading alone is not a statement. */
export const MIN_STATEMENT_SECTION_LENGTH = 20;

export type StatementOfPurposeProblem =
  | "aims_missing"
  | "service_kinds_missing"
  | "needs_missing"
  | "provider_name_missing"
  | "provider_address_missing"
  | "provider_phone_missing"
  | "manager_details_missing"
  | "service_address_missing"
  | "service_email_missing"
  | "legal_status_missing"
  | "locations_missing"
  | "location_details_missing";

export const STATEMENT_OF_PURPOSE_MESSAGES: Readonly<Record<StatementOfPurposeProblem, string>> = {
  aims_missing: "Describe the aims and objectives of the service.",
  service_kinds_missing: "List the kinds of service provided.",
  needs_missing: "Describe the range of needs the services are meant to meet.",
  provider_name_missing: "Give the provider's full name.",
  provider_address_missing: "Give the provider's business address.",
  provider_phone_missing: "Give the provider's business telephone number.",
  manager_details_missing:
    "Give each registered manager's full name, business address and business telephone number.",
  service_address_missing: "Give the address CQC should send notices and documents to.",
  service_email_missing:
    "The provider agreed to receive notices by email, so give the email address.",
  legal_status_missing: "Give the provider's legal status.",
  locations_missing: "List the locations where the service is provided.",
  location_details_missing: "Give each location's name and address.",
};

const PROBLEM_ITEM: Readonly<Record<StatementOfPurposeProblem, StatementOfPurposeItemKey>> = {
  aims_missing: "aims_and_objectives",
  service_kinds_missing: "services_and_needs",
  needs_missing: "services_and_needs",
  provider_name_missing: "contact_details",
  provider_address_missing: "contact_details",
  provider_phone_missing: "contact_details",
  manager_details_missing: "contact_details",
  service_address_missing: "contact_details",
  service_email_missing: "contact_details",
  legal_status_missing: "legal_status",
  locations_missing: "locations",
  location_details_missing: "locations",
};

function hasText(value: string | null | undefined, min = 1): boolean {
  return (value?.trim().length ?? 0) >= min;
}

function contactComplete(contact: BusinessContact): boolean {
  return (
    hasText(contact.fullName) && hasText(contact.businessAddress) && hasText(contact.businessPhone)
  );
}

export interface StatementOfPurposeChecklist {
  readonly complete: boolean;
  readonly items: readonly {
    readonly key: StatementOfPurposeItemKey;
    readonly title: string;
    readonly complete: boolean;
    readonly problems: readonly StatementOfPurposeProblem[];
    readonly citation: Citation;
  }[];
  /** Not a Schedule 3 gap, but worth a second look ("any registered manager"). */
  readonly warnings: readonly "no_registered_manager"[];
}

/** Validates a draft against Schedule 3 (quality.md rule 8). */
export function checkStatementOfPurpose(
  content: StatementOfPurposeContent,
): StatementOfPurposeChecklist {
  const problems: StatementOfPurposeProblem[] = [];
  if (!hasText(content.aimsAndObjectives, MIN_STATEMENT_SECTION_LENGTH))
    problems.push("aims_missing");
  if (!content.serviceKinds.some((k) => hasText(k))) problems.push("service_kinds_missing");
  if (!hasText(content.needsMet, MIN_STATEMENT_SECTION_LENGTH)) problems.push("needs_missing");
  if (!hasText(content.provider.fullName)) problems.push("provider_name_missing");
  if (!hasText(content.provider.businessAddress)) problems.push("provider_address_missing");
  if (!hasText(content.provider.businessPhone)) problems.push("provider_phone_missing");
  if (content.registeredManagers.some((m) => !contactComplete(m))) {
    problems.push("manager_details_missing");
  }
  if (!hasText(content.serviceAddress)) problems.push("service_address_missing");
  if (content.consentsToEmailService && !hasText(content.serviceEmail)) {
    problems.push("service_email_missing");
  }
  if (
    content.legalStatus === null ||
    (content.legalStatus === "other" && !hasText(content.legalStatusDetail))
  ) {
    problems.push("legal_status_missing");
  }
  if (content.locations.length === 0) problems.push("locations_missing");
  else if (content.locations.some((l) => !hasText(l.name) || !hasText(l.address))) {
    problems.push("location_details_missing");
  }
  const items = STATEMENT_OF_PURPOSE_ITEMS.map((definition) => {
    const own = problems.filter((p) => PROBLEM_ITEM[p] === definition.key);
    return {
      key: definition.key,
      title: definition.title,
      complete: own.length === 0,
      problems: own,
      citation: definition.citation,
    };
  });
  return {
    complete: problems.length === 0,
    items,
    warnings: content.registeredManagers.length === 0 ? ["no_registered_manager"] : [],
  };
}

// ------------------------------------------------------------------------------------------------
// Change summary between versions (rule 9)
// ------------------------------------------------------------------------------------------------

export type SectionChangeKind = "unchanged" | "changed";

export interface StatementOfPurposeSectionChange {
  readonly key: StatementOfPurposeItemKey;
  readonly title: string;
  readonly change: SectionChangeKind;
  /** Plain-English lines, for example "Location added: Harbour Lodge". */
  readonly lines: readonly string[];
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").trim() === (b ?? "").trim();

function listChanges<T extends { readonly id: string }>(
  label: string,
  before: readonly T[],
  after: readonly T[],
  name: (item: T) => string,
  equal: (a: T, b: T) => boolean,
): string[] {
  const lines: string[] = [];
  for (const item of after) {
    const old = before.find((b) => b.id === item.id);
    if (!old) lines.push(`${label} added: ${name(item)}`);
    else if (!equal(old, item)) lines.push(`${label} changed: ${name(item)}`);
  }
  for (const item of before) {
    if (!after.some((a) => a.id === item.id)) lines.push(`${label} removed: ${name(item)}`);
  }
  return lines;
}

function contactLines(label: string, before: BusinessContact, after: BusinessContact): string[] {
  const fields: [keyof BusinessContact, string][] = [
    ["fullName", "name"],
    ["businessAddress", "business address"],
    ["businessPhone", "business telephone number"],
    ["email", "email address"],
  ];
  return fields.filter(([f]) => !same(before[f], after[f])).map(([, w]) => `${label} ${w} changed`);
}

/**
 * A section-level summary of what changed between two versions. With no previous version (the
 * first statement in Harbour) every section with content reads "changed".
 */
export function statementOfPurposeChanges(
  previous: StatementOfPurposeContent | null,
  next: StatementOfPurposeContent,
): readonly StatementOfPurposeSectionChange[] {
  const lines: Record<StatementOfPurposeItemKey, string[]> = {
    aims_and_objectives: [],
    services_and_needs: [],
    contact_details: [],
    legal_status: [],
    locations: [],
  };
  if (previous === null) {
    for (const key of STATEMENT_OF_PURPOSE_ITEM_KEYS) lines[key].push("First version in Harbour");
  } else {
    if (!same(previous.aimsAndObjectives, next.aimsAndObjectives)) {
      lines.aims_and_objectives.push("Aims and objectives reworded");
    }
    for (const kind of next.serviceKinds) {
      if (!previous.serviceKinds.includes(kind))
        lines.services_and_needs.push(`Service added: ${kind}`);
    }
    for (const kind of previous.serviceKinds) {
      if (!next.serviceKinds.includes(kind)) {
        lines.services_and_needs.push(`Service removed: ${kind}`);
      }
    }
    if (!same(previous.needsMet, next.needsMet)) {
      lines.services_and_needs.push("Range of needs met reworded");
    }
    lines.contact_details.push(...contactLines("Provider", previous.provider, next.provider));
    lines.contact_details.push(
      ...listChanges(
        "Registered manager",
        previous.registeredManagers,
        next.registeredManagers,
        (m) => m.fullName.trim(),
        (a, b) => contactLines("", a, b).length === 0,
      ),
    );
    if (
      !same(previous.serviceAddress, next.serviceAddress) ||
      !same(previous.serviceEmail, next.serviceEmail) ||
      previous.consentsToEmailService !== next.consentsToEmailService
    ) {
      lines.contact_details.push("Address for CQC notices changed");
    }
    if (
      previous.legalStatus !== next.legalStatus ||
      !same(previous.legalStatusDetail, next.legalStatusDetail)
    ) {
      lines.legal_status.push("Legal status changed");
    }
    lines.locations.push(
      ...listChanges(
        "Location",
        previous.locations,
        next.locations,
        (l) => l.name.trim(),
        (a, b) =>
          same(a.name, b.name) &&
          same(a.address, b.address) &&
          same(a.cqcLocationId, b.cqcLocationId),
      ),
    );
  }
  return STATEMENT_OF_PURPOSE_ITEMS.map((definition) => ({
    key: definition.key,
    title: definition.title,
    change: lines[definition.key].length > 0 ? "changed" : "unchanged",
    lines: lines[definition.key],
  }));
}

export type RegistrationPromptKind =
  | "location_added_or_removed"
  | "registered_manager_changed"
  | "legal_status_changed";

export interface RegistrationPrompt {
  readonly kind: RegistrationPromptKind;
  readonly message: string;
  readonly citation: Citation;
}

/**
 * Changes that usually need an application to CQC as well as a revised statement (Harbour's
 * reading, confirmed with CQC under human action H-97). Harbour prompts; it does not decide.
 */
export function statementOfPurposeRegistrationPrompts(
  previous: StatementOfPurposeContent | null,
  next: StatementOfPurposeContent,
): readonly RegistrationPrompt[] {
  if (previous === null) return [];
  const prompts: RegistrationPrompt[] = [];
  const ids = (list: readonly { readonly id: string }[]) =>
    list
      .map((x) => x.id)
      .sort()
      .join("|");
  if (ids(previous.locations) !== ids(next.locations)) {
    prompts.push({
      kind: "location_added_or_removed",
      message:
        "Adding or removing a location usually needs an application to CQC to vary the conditions of registration. Send the revised statement with it.",
      citation: cite(HSCA_2008, "s.19", HSCA_2008_S19),
    });
  }
  if (ids(previous.registeredManagers) !== ids(next.registeredManagers)) {
    prompts.push({
      kind: "registered_manager_changed",
      message:
        "A new registered manager applies to CQC for registration as a manager. Check what CQC needs for the change.",
      citation: cite(HSCA_2008, "s.14", HSCA_2008_S14),
    });
  }
  if (previous.legalStatus !== next.legalStatus) {
    prompts.push({
      kind: "legal_status_changed",
      message:
        "A change of legal entity usually means the new entity must register with CQC. Check with CQC before the change.",
      citation: cite(HSCA_2008, "s.10", HSCA_2008_S10),
    });
  }
  return prompts;
}

// ------------------------------------------------------------------------------------------------
// Versions, approval and the CQC notification (rules 10 to 12)
// ------------------------------------------------------------------------------------------------

export type StatementOfPurposeState = "draft" | "approved" | "superseded" | "discarded";

/**
 * Draft to approved (by a holder of the approve permission who did not write it), approved to
 * superseded when a later revision is approved. Approved versions never change.
 */
export const STATEMENT_OF_PURPOSE_WORKFLOW = defineWorkflow<StatementOfPurposeState>({
  key: "quality.statement_of_purpose",
  version: 1,
  states: ["draft", "approved", "superseded", "discarded"],
  initial: "draft",
  terminal: ["superseded", "discarded"],
  transitions: [
    {
      from: "draft",
      to: "approved",
      permission: "quality.statement_of_purpose.approve",
      distinctFromCreator: true,
    },
    {
      from: "draft",
      to: "discarded",
      permission: "quality.statement_of_purpose.write",
      requiresReason: true,
    },
    { from: "approved", to: "superseded", permission: "quality.statement_of_purpose.approve" },
  ],
});

export interface StatementOfPurposeVersion {
  readonly id: string;
  readonly version: number;
  readonly state: StatementOfPurposeState;
  /**
   * `baseline` is the statement CQC already holds, loaded when the provider starts on Harbour;
   * it needs no notification. Every later approved version is a `revision`.
   */
  readonly kind: "baseline" | "revision";
  readonly content: StatementOfPurposeContent;
  readonly authorId: string;
  /** Everyone who edited this version, the author included. */
  readonly contributorIds: readonly string[];
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
  readonly notifiedAt: Date | null;
}

export type StatementOfPurposeApprovalProblem =
  | "not_draft"
  | "missing_permission"
  | "author_cannot_approve"
  | "incomplete"
  | "no_changes";

export const STATEMENT_OF_PURPOSE_APPROVAL_MESSAGES: Readonly<
  Record<StatementOfPurposeApprovalProblem, string>
> = {
  not_draft: "Only a draft can be approved.",
  missing_permission:
    "Only the registered provider or a registered manager can approve the statement of purpose.",
  author_cannot_approve: "Someone who did not write or edit this version must approve it.",
  incomplete: "The statement is missing information that Schedule 3 requires.",
  no_changes: "This version is the same as the current statement.",
};

export interface StatementOfPurposeApproval {
  readonly supersedesVersionId: string | null;
  readonly changes: readonly StatementOfPurposeSectionChange[];
  readonly registrationPrompts: readonly RegistrationPrompt[];
  /** Null for a baseline; otherwise when CQC must have the written details (reg 12(3)). */
  readonly notificationDueAt: Date | null;
  readonly citation: Citation;
}

export type StatementOfPurposeApprovalCheck =
  | ({ readonly ok: true } & StatementOfPurposeApproval)
  | { readonly ok: false; readonly problems: readonly StatementOfPurposeApprovalProblem[] };

/** Checks an approval and works out what follows: the change summary and the notice clock. */
export function checkStatementOfPurposeApproval(
  draft: StatementOfPurposeVersion,
  current: StatementOfPurposeVersion | null,
  approver: { readonly id: string; readonly permissions: ReadonlySet<string>; readonly at: Date },
  rates: StatementOfPurposeRates,
): StatementOfPurposeApprovalCheck {
  const problems: StatementOfPurposeApprovalProblem[] = [];
  if (draft.state !== "draft") problems.push("not_draft");
  if (!approver.permissions.has("quality.statement_of_purpose.approve")) {
    problems.push("missing_permission");
  }
  if (draft.authorId === approver.id || draft.contributorIds.includes(approver.id)) {
    problems.push("author_cannot_approve");
  }
  if (!checkStatementOfPurpose(draft.content).complete) problems.push("incomplete");
  const changes = statementOfPurposeChanges(current?.content ?? null, draft.content);
  if (current !== null && changes.every((c) => c.change === "unchanged")) {
    problems.push("no_changes");
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    supersedesVersionId: current?.id ?? null,
    changes,
    registrationPrompts: statementOfPurposeRegistrationPrompts(
      current?.content ?? null,
      draft.content,
    ),
    notificationDueAt:
      draft.kind === "baseline" ? null : addUkDays(approver.at, rates.revisionNoticeDays),
    citation: cite(REGISTRATION_REGS, "reg 12(3)", REG_12),
  };
}

export type StatementOfPurposeNotificationState =
  | { readonly state: "not_required" }
  | { readonly state: "due"; readonly dueAt: Date }
  | { readonly state: "overdue"; readonly dueAt: Date }
  | { readonly state: "notified"; readonly notifiedAt: Date; readonly late: boolean };

/** Where an approved revision stands against the regulation 12(3) notice period. */
export function statementOfPurposeNotificationState(
  version: Pick<StatementOfPurposeVersion, "kind" | "approvedAt" | "notifiedAt">,
  rates: StatementOfPurposeRates,
  at: Date,
): StatementOfPurposeNotificationState {
  if (version.kind === "baseline" || version.approvedAt === null) return { state: "not_required" };
  const dueAt = addUkDays(version.approvedAt, rates.revisionNoticeDays);
  if (version.notifiedAt !== null) {
    return {
      state: "notified",
      notifiedAt: version.notifiedAt,
      late: version.notifiedAt.getTime() > dueAt.getTime(),
    };
  }
  return at.getTime() > dueAt.getTime() ? { state: "overdue", dueAt } : { state: "due", dueAt };
}

export type StatementOfPurposeNotificationProblem =
  | "not_required"
  | "missing_permission"
  | "step_up_required"
  | "before_approval"
  | "evidence_required";

export const STATEMENT_OF_PURPOSE_NOTIFICATION_MESSAGES: Readonly<
  Record<StatementOfPurposeNotificationProblem, string>
> = {
  not_required: "This version does not need to be sent to CQC.",
  missing_permission: "Only someone who submits CQC notifications can record this.",
  step_up_required: "Sign in again to confirm it is you, then record the submission.",
  before_approval: "The submission cannot be before the version was approved.",
  evidence_required: "Give the CQC reference or say how and when it was sent.",
};

/**
 * Recording that the written details went to CQC. CQC notifications are submitted only by holders
 * of `safety.notification.submit`, with step-up (master prompt section 4).
 */
export function checkStatementOfPurposeNotificationRecord(
  version: Pick<StatementOfPurposeVersion, "kind" | "state" | "approvedAt" | "notifiedAt">,
  record: {
    readonly permissions: ReadonlySet<string>;
    readonly stepUpFresh: boolean;
    readonly sentAt: Date;
    readonly evidence: string | null;
  },
): readonly StatementOfPurposeNotificationProblem[] {
  const problems: StatementOfPurposeNotificationProblem[] = [];
  if (
    version.kind === "baseline" ||
    version.approvedAt === null ||
    version.notifiedAt !== null ||
    version.state === "draft" ||
    version.state === "discarded"
  ) {
    problems.push("not_required");
  }
  if (!record.permissions.has("safety.notification.submit")) problems.push("missing_permission");
  else if (!record.stepUpFresh) problems.push("step_up_required");
  if (version.approvedAt !== null && record.sentAt.getTime() < version.approvedAt.getTime()) {
    problems.push("before_approval");
  }
  if (!hasText(record.evidence, 3)) problems.push("evidence_required");
  return problems;
}

/** A new draft from the current approved version; approved versions themselves never change. */
export function startStatementOfPurposeRevision(
  current: StatementOfPurposeVersion,
  newId: string,
  authorId: string,
): StatementOfPurposeVersion {
  return {
    id: newId,
    version: current.version + 1,
    state: "draft",
    kind: "revision",
    content: current.content,
    authorId,
    contributorIds: [authorId],
    approvedBy: null,
    approvedAt: null,
    notifiedAt: null,
  };
}
