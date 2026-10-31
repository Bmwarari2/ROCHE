import { z } from "zod";
import { BreakGlassReasonCode } from "./people";
import { PersonSummary } from "./person-summary";
import { StaffName } from "./staff";

/**
 * Harbour API contracts (master prompt section 6): one set of Zod schemas shared by the API, the
 * web app and the mobile app. `.meta({ id })` names each schema as an OpenAPI 3.1 component.
 * Responses never carry more personal data than the screen needs.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });

export const ProblemDetails = z
  .object({
    type: z.string().default("about:blank"),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    instance: z.string().optional(),
    /** Stable machine-readable code, e.g. `missing_permission`, `step_up_required`. */
    code: z.string(),
    requestId: z.string().optional(),
  })
  .meta({ id: "ProblemDetails", description: "RFC 9457 problem details with a stable code" });
export type ProblemDetails = z.infer<typeof ProblemDetails>;

export const Health = z
  .object({
    status: z.enum(["ok", "degraded"]),
    version: z.string(),
    database: z.enum(["ok", "unavailable"]),
  })
  .meta({ id: "Health" });
export type Health = z.infer<typeof Health>;

export const DataScope = z
  .enum(["tenant", "locations", "assigned", "none"])
  .meta({ id: "DataScope" });

export const Membership = z
  .object({
    tenantId: uuid,
    tenantName: z.string(),
  })
  .meta({ id: "Membership" });
export type Membership = z.infer<typeof Membership>;

export const DeviceSession = z
  .object({
    id: z.string(),
    device: z.string().nullable().meta({ description: "User agent of the signed-in device" }),
    createdAt: isoDateTime,
    lastActiveAt: isoDateTime,
    expiresAt: isoDateTime,
    current: z.boolean(),
  })
  .meta({
    id: "DeviceSession",
    description: "A device where the person is signed in. Never carries the session token.",
  });
export type DeviceSession = z.infer<typeof DeviceSession>;

export const DeviceSessionList = z
  .object({ items: z.array(DeviceSession) })
  .meta({ id: "DeviceSessionList" });
export type DeviceSessionList = z.infer<typeof DeviceSessionList>;

/** Why a manager signed a member of staff out of every device: a code, never words. */
export const MEMBER_SIGN_OUT_REASONS = [
  "lost_or_stolen_device",
  "staff_left",
  "suspended",
  "suspected_misuse",
  "other",
] as const;

export const RevokeMemberSessions = z
  .object({
    reasonCode: z.enum(MEMBER_SIGN_OUT_REASONS),
    /**
     * True once the manager has been told how many entries the member's devices last reported
     * waiting: they stay on each device, protected, until the member signs in again to send them.
     */
    confirmEntriesWaiting: z.boolean().optional(),
  })
  .meta({ id: "RevokeMemberSessions" });
export type RevokeMemberSessions = z.infer<typeof RevokeMemberSessions>;

export const RevokeMemberSessionsResult = z
  .object({
    /** Sessions ended, on every device and in every organisation the person belongs to. */
    revoked: z.number().int().min(0),
    /** Entries the member's devices last reported waiting (0 when none). */
    entriesWaiting: z.number().int().min(0),
  })
  .meta({ id: "RevokeMemberSessionsResult" });
export type RevokeMemberSessionsResult = z.infer<typeof RevokeMemberSessionsResult>;

export const LocationSummary = z
  .object({
    id: uuid,
    name: z.string(),
    regulator: z.enum(["cqc", "ciw", "care_inspectorate", "rqia", "ofsted"]),
    regulatorLocationId: z.string().nullable(),
    nation: z.enum(["england", "wales", "scotland", "northern_ireland"]),
  })
  .meta({ id: "LocationSummary" });
export type LocationSummary = z.infer<typeof LocationSummary>;

export const Me = z
  .object({
    user: z.object({ id: z.string(), name: z.string(), email: z.email() }),
    tenant: z.object({
      id: uuid,
      name: z.string(),
      terminology: z.enum(["resident", "client", "person_we_support"]),
      /** A colour that passed `checkAccent` (PLAT-002), or null for Harbour's own. */
      brandAccent: z.string().nullable(),
      /** The white-label logo, served by GET /v1/branding/logo; null when there is none. */
      logoDocumentId: uuid.nullable(),
      nation: z.enum(["england", "wales", "scotland", "northern_ireland"]),
    }),
    tenantUserId: uuid,
    memberships: z.array(Membership),
    locations: z.array(LocationSummary),
    permissions: z.array(z.string()),
    roleKeys: z.array(z.string()),
    scope: DataScope,
    flags: z.record(z.string(), z.boolean()),
    /**
     * HZ-072: true while the organisation has sample data in place, so every screen shows the
     * sample data banner (platform-completions.md rules 29 to 32).
     */
    sampleData: z.boolean(),
  })
  .meta({ id: "Me", description: "The signed-in user, their active tenant and effective access" });
export type Me = z.infer<typeof Me>;

export const PersonList = z
  .object({ items: z.array(PersonSummary), nextCursor: z.string().nullable() })
  .meta({ id: "PersonList" });
export type PersonList = z.infer<typeof PersonList>;

export const NotificationItem = z
  .object({
    id: uuid,
    kind: z.string(),
    severity: z.enum(["info", "warning", "urgent"]),
    title: z.string(),
    body: z.string().nullable(),
    link: z.string().nullable(),
    createdAt: isoDateTime,
    readAt: isoDateTime.nullable(),
    acknowledgedAt: isoDateTime.nullable(),
  })
  .meta({ id: "NotificationItem" });
export type NotificationItem = z.infer<typeof NotificationItem>;

export const NotificationList = z
  .object({ items: z.array(NotificationItem), unread: z.number().int() })
  .meta({ id: "NotificationList" });
export type NotificationList = z.infer<typeof NotificationList>;

export const SyncToken = z
  .object({ token: z.string(), endpoint: z.url(), expiresAt: isoDateTime })
  .meta({
    id: "SyncToken",
    description: "Short-lived PowerSync token scoped to tenant and assignments",
  });
export type SyncToken = z.infer<typeof SyncToken>;

export const SyncOperation = z
  .object({
    op: z.enum(["PUT", "PATCH", "DELETE"]),
    table: z.string(),
    id: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
    /** Device clock when the batch was sent, for drift detection (HZ-010). */
    deviceSentAt: isoDateTime.optional(),
    /**
     * Device clock when the entry was recorded: a bank or agency worker's entry is accepted only
     * if recorded inside a booked window, and after it closes only for the upload grace period
     * (H-921).
     */
    recordedAt: isoDateTime.optional(),
  })
  .meta({ id: "SyncOperation" });

export const SyncUpload = z
  .object({ operations: z.array(SyncOperation).max(500) })
  .meta({ id: "SyncUpload" });
export type SyncUpload = z.infer<typeof SyncUpload>;

export const SyncUploadResult = z
  .object({
    applied: z.number().int(),
    rejected: z.array(z.object({ id: z.string(), code: z.string(), message: z.string() })),
  })
  .meta({ id: "SyncUploadResult" });
export type SyncUploadResult = z.infer<typeof SyncUploadResult>;

/** What a device deleted that never reached the server (HZ-006, HZ-040). */
export const SYNC_DISCARD_KINDS = [
  "held_deleted",
  "signed_out_with_unsent",
  "refused_removed",
] as const;

/**
 * Why: a coded reason. The person's own words never reach the server's audit trail, which is
 * hash-chained and kept for years (security review round 4, M3); they stay on the device. Each
 * organisation keeps its own coded reasons (`GET /v1/discard-reasons`), starting with these; the
 * phone offers these until it reads the organisation's list.
 */
export const SYNC_DISCARD_REASON_CODES = [
  "recorded_elsewhere",
  "entered_in_error",
  "staff_left",
  "nurse_in_charge_informed",
  "other",
] as const;

/** A coded reason: lower-case letters, digits and underscores, starting with a letter. */
export const DiscardReasonCode = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,39}$/)
  .meta({ id: "DiscardReasonCode" });

export const DiscardReasonItem = z
  .object({
    /** Changed by this id (`PUT /v1/discard-reasons/{reasonId}`), never by the code. */
    id: z.uuid(),
    code: DiscardReasonCode,
    /** The wording staff read, in English. */
    label: z.string(),
    /** The Welsh wording, when the organisation has given one. */
    labelCy: z.string().nullable(),
    sortOrder: z.number().int(),
    /** One of the codes every organisation starts with. */
    seeded: z.boolean(),
    /** When it stopped being offered; a device that used it before may still send it. */
    retiredAt: isoDateTime.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "DiscardReasonItem" });
export type DiscardReasonItem = z.infer<typeof DiscardReasonItem>;

export const DiscardReasonList = z
  .object({ items: z.array(DiscardReasonItem) })
  .meta({ id: "DiscardReasonList" });
export type DiscardReasonList = z.infer<typeof DiscardReasonList>;

export const CreateDiscardReason = z
  .object({
    code: DiscardReasonCode,
    label: z.string().trim().min(3).max(120),
    labelCy: z.string().trim().min(3).max(120).nullable().optional(),
    sortOrder: z.number().int().min(0).max(1000).default(50),
  })
  .meta({
    id: "CreateDiscardReason",
    description: "Adds a coded reason for deleting unsent entries on a device",
  });
export type CreateDiscardReason = z.infer<typeof CreateDiscardReason>;

export const UpdateDiscardReason = z
  .object({
    label: z.string().trim().min(3).max(120).optional(),
    labelCy: z.string().trim().min(3).max(120).nullable().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    /** True stops it being offered; false offers it again. */
    retired: z.boolean().optional(),
    version: z.number().int().min(1),
  })
  .meta({ id: "UpdateDiscardReason" });
export type UpdateDiscardReason = z.infer<typeof UpdateDiscardReason>;

/**
 * Where a deletion stands (clinical review round 4, H1): `requested` is recorded before anything is
 * deleted; `deleted` only once the device has checked the entries are gone; `failed` when they
 * survived, superseding the request.
 */
export const SYNC_DISCARD_STAGES = ["requested", "deleted", "failed"] as const;

/** Most entry ids one record carries; a larger hold sends a sample and its count. */
export const SYNC_DISCARD_MAX_ENTRY_IDS = 500;

/**
 * What of the database a deletion recorded as `deleted` left on the device, though its entries can
 * no longer be read (clinical review round 5, C-M1): recorded as a separate security event.
 */
export const SYNC_DISCARD_LEFTOVERS = ["file", "key"] as const;

/**
 * Why a deletion lists no entry ids (clinical review round 5, C-M2): the device had no key for the
 * database (`key_absent`), or the key it had was not a valid one (`key_invalid`), so nothing on it
 * could be read. A deletion is otherwise refused when its ids cannot be read.
 */
export const SYNC_DISCARD_IDS_MISSING = ["key_absent", "key_invalid"] as const;

export const SyncDiscard = z
  .object({
    /** The device's tombstone id: each stage of the same deletion is recorded once. */
    id: uuid,
    kind: z.enum(SYNC_DISCARD_KINDS),
    stage: z.enum(SYNC_DISCARD_STAGES),
    /**
     * The coded reason: one of the five every organisation starts with. A reason the organisation
     * added goes in `organisationReasonCode`, with `other` here.
     */
    reasonCode: z.enum(SYNC_DISCARD_REASON_CODES),
    /**
     * One of the organisation's own coded reasons (`GET /v1/discard-reasons`), when the reason is
     * one it added; `reasonCode` is then `other`. The API checks it against the organisation's
     * list: a code it never had is refused, a retired one still taken.
     */
    organisationReasonCode: DiscardReasonCode.optional(),
    /** Who wrote the entries (tenant_user id), when the device knows. */
    ownerTenantUserId: uuid.nullable(),
    /**
     * Who deleted them (tenant_user id), as the device recorded it at the time: the owner, a
     * manager, or the person signing out. Anyone but the caller needs a manager's permission.
     */
    deletedByTenantUserId: uuid.nullable().optional(),
    /** Ids of the entries, or a sample of them for a large hold (never more than `count`). */
    entryIds: z.array(uuid).max(SYNC_DISCARD_MAX_ENTRY_IDS),
    personIds: z.array(uuid).max(200),
    /** How many entries were deleted; null when the device could not count them. */
    count: z.number().int().min(0).max(100_000).nullable(),
    discardedAt: isoDateTime,
    /** On `deleted`: what was left on the device though the entries can no longer be read. */
    leftover: z.array(z.enum(SYNC_DISCARD_LEFTOVERS)).max(2).optional(),
    /** Why there are no entry ids, when there are none. */
    idsMissing: z.enum(SYNC_DISCARD_IDS_MISSING).optional(),
    /**
     * The device the entries were held on (its PowerSync client id when the deletion began), so a
     * stage sent later from the device's next database still closes that device's hold task.
     */
    deviceId: uuid.optional(),
  })
  // Unknown keys are refused, not dropped (security review round 5, S-L6).
  .strict()
  .refine((d) => d.count === null || d.entryIds.length <= d.count, {
    message: "There are more entry ids than entries.",
    path: ["entryIds"],
  })
  .refine((d) => d.organisationReasonCode === undefined || d.reasonCode === "other", {
    message: "Send an organisation's own reason with the reason code other.",
    path: ["reasonCode"],
  })
  .meta({
    id: "SyncDiscard",
    description:
      "A device deleted, or is about to delete, entries that never reached the server; recorded as an audit event",
  });
export type SyncDiscard = z.infer<typeof SyncDiscard>;

export const SyncDiscardResult = z
  .object({ id: uuid, recorded: z.boolean(), replay: z.boolean() })
  .meta({ id: "SyncDiscardResult" });
export type SyncDiscardResult = z.infer<typeof SyncDiscardResult>;

/** Locations a device report may name. */
export const SYNC_DEVICE_REPORT_MAX_LOCATIONS = 50;

/** A device's unsent work, without personal data (HZ-006: queue depth seen by the server). */
export const SyncDeviceReport = z
  .object({
    /** Entries waiting in the upload queue. */
    unsent: z.number().int().min(0).max(1_000_000),
    /** Entries the server refused, kept on the device. */
    refused: z.number().int().min(0).max(1_000_000),
    /** Entries held after a session ended. */
    held: z.number().int().min(0).max(1_000_000),
    /**
     * Entries left by a deletion that did not finish, which are never sent and wait for a person
     * to check them (clinical review round 5, C-M3).
     */
    blocked: z.number().int().min(0).max(1_000_000),
    /** Age of the oldest unsent, refused or held entry in seconds; null when there is none. */
    oldestAgeSeconds: z
      .number()
      .int()
      .min(0)
      .max(10 * 365 * 24 * 3600)
      .nullable(),
    /** When the current hold started, if entries are held; the manager's task falls due from it. */
    heldSince: isoDateTime.nullable().optional(),
    reportedAt: isoDateTime,
    /**
     * Whose entries these are (tenant_user id), when the device knows: the hold's owner, who may
     * close the task, even when the next person to sign in sends the report for them.
     */
    ownerTenantUserId: uuid.nullable().optional(),
    /**
     * The locations of the device's sync scope (opaque ids). The server keeps those where the
     * owner or the reporter works or last worked, and raises the task at each.
     */
    locationIds: z.array(uuid).max(SYNC_DEVICE_REPORT_MAX_LOCATIONS).optional(),
    /**
     * Refused entries whose content the server would not keep a copy of (a refusal other than a
     * wait, or content a copy cannot carry), so a manager knows they exist only on this device
     * (care.md section 6, Device integrity part 5).
     */
    copiesRefused: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict()
  .meta({ id: "SyncDeviceReport" });
export type SyncDeviceReport = z.infer<typeof SyncDeviceReport>;

export const AuditEntry = z
  .object({
    id: uuid,
    occurredAt: isoDateTime,
    action: z.string(),
    outcome: z.enum(["success", "denied", "error"]),
    actorTenantUserId: uuid.nullable(),
    resourceType: z.string().nullable(),
    resourceId: z.string().nullable(),
    reason: z.string().nullable(),
    chainPosition: z.number().int().nullable(),
  })
  .meta({ id: "AuditEntry" });
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AuditList = z
  .object({ items: z.array(AuditEntry), chainIntact: z.boolean() })
  .meta({ id: "AuditList" });
export type AuditList = z.infer<typeof AuditList>;

export const RecordVersion = z
  .object({
    version: z.number().int(),
    validFrom: isoDateTime,
    validTo: isoDateTime,
    changedBy: uuid.nullable(),
    /** Who made the change, by name and job title; null when not known. */
    changedByStaff: StaffName.nullable(),
    data: z.record(z.string(), z.unknown()),
  })
  .meta({ id: "RecordVersion" });

export const RecordHistory = z
  .object({
    table: z.string(),
    recordId: uuid,
    versions: z.array(RecordVersion),
    /**
     * The stored field keys the latest change altered: where the newest earlier version differs
     * from the record as it is now. Empty when there is no earlier version; null when the record
     * was saved again while it was read, so nothing could be compared. Keys only, never the current
     * values (the record's own route shows those, under its own permission).
     */
    latestChanged: z.array(z.string()).nullable(),
  })
  .meta({ id: "RecordHistory", description: "Human-readable history of a mutable record" });
export type RecordHistory = z.infer<typeof RecordHistory>;

export const FormTemplateSummary = z
  .object({
    id: uuid,
    key: z.string(),
    version: z.number().int(),
    title: z.string(),
    kind: z.string(),
    locked: z.boolean(),
    global: z.boolean(),
  })
  .meta({ id: "FormTemplateSummary" });
export type FormTemplateSummary = z.infer<typeof FormTemplateSummary>;

export const BreakGlassRequest = z
  .object({
    personId: uuid,
    justification: z
      .string()
      .trim()
      .min(20, "Explain why you need this record (20 characters or more)."),
    /** The kind of reason, for the weekly report; the typed justification is still required. */
    reasonCode: BreakGlassReasonCode.optional(),
  })
  .meta({ id: "BreakGlassRequest" });
export type BreakGlassRequest = z.infer<typeof BreakGlassRequest>;

export const BreakGlassResult = z
  .object({ id: uuid, expiresAt: isoDateTime })
  .meta({ id: "BreakGlassResult" });
export type BreakGlassResult = z.infer<typeof BreakGlassResult>;

export const RateValue = z
  .object({
    key: z.string(),
    value: z.number(),
    unit: z.string(),
    nation: z.string(),
    verified: z.boolean(),
    source: z.string(),
    tenantOverride: z.boolean(),
  })
  .meta({ id: "RateValue" });
export type RateValue = z.infer<typeof RateValue>;

/** Header carrying the active tenant chosen in the tenant switcher. */
export const TENANT_HEADER = "x-harbour-tenant";
/** Header carrying the device id, recorded in the audit log. */
export const DEVICE_HEADER = "x-harbour-device";

export * from "./agency";
export * from "./branding";
export * from "./care";
export * from "./care-planning";
export * from "./client-id";
export * from "./devices";
export * from "./dpia";
export { BackEntryInput, DeviceDeletionFlag, EntryBackEntry, EntryNotFromPaper } from "./entries";
export * from "./escalation-policy";
export * from "./exports";
export * from "./family-feed";
export * from "./handover";
export * from "./invitations";
export * from "./letters";
export * from "./mca";
export * from "./members";
export * from "./onboarding";
export * from "./operations";
export * from "./people";
export * from "./person-summary";
export * from "./quality";
export * from "./records";
export * from "./rota";
export * from "./safety";
export * from "./scheduling";
export * from "./search";
export * from "./staff";
export * from "./sub-processors";
export * from "./tasks";
export * from "./time-attendance";

/**
 * A member asks for their own account to be deleted (MOB-011; master prompt 17.3; App Store
 * guideline 5.1.1(v) and Google Play's account deletion policy). Staff accounts belong to the care
 * provider, the controller, so the request goes to the people who manage its members as a task;
 * nothing is deleted by the request, and no care record ever is.
 */
export const AccountDeletionRequest = z
  .object({
    /** `requested` the first time; `already_requested` while an earlier request is still open. */
    status: z.enum(["requested", "already_requested"]),
    requestedAt: isoDateTime,
    /** When the organisation is asked to have confirmed (`account_deletion.confirmation_days`). */
    respondBy: isoDateTime,
    /** False when the organisation has no one who manages members: the request is still kept. */
    routedToManager: z.boolean(),
  })
  .meta({ id: "AccountDeletionRequest" });
export type AccountDeletionRequest = z.infer<typeof AccountDeletionRequest>;
export * from "./workforce";
