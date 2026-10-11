import { z } from "zod";
import { ResuscitationStatus } from "./care-planning";

/**
 * Harbour API contracts (master prompt section 6): one set of Zod schemas shared by the API, the
 * web app and the mobile app. `.meta({ id })` names each schema as an OpenAPI 3.1 component.
 * Responses never carry more personal data than the screen needs.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();

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
      brandAccent: z.string().nullable(),
      nation: z.enum(["england", "wales", "scotland", "northern_ireland"]),
    }),
    tenantUserId: uuid,
    memberships: z.array(Membership),
    locations: z.array(LocationSummary),
    permissions: z.array(z.string()),
    roleKeys: z.array(z.string()),
    scope: DataScope,
    flags: z.record(z.string(), z.boolean()),
  })
  .meta({ id: "Me", description: "The signed-in user, their active tenant and effective access" });
export type Me = z.infer<typeof Me>;

export const CommunicationNeed = z
  .object({
    code: z.string().describe("SNOMED CT concept id (Accessible Information Standard)"),
    display: z.string(),
    preferredFormat: z.string().optional(),
  })
  .meta({ id: "CommunicationNeed" });
export type CommunicationNeed = z.infer<typeof CommunicationNeed>;

export const AllergyStatus = z
  .enum(["unknown", "no_known_allergies", "has_allergies"])
  .meta({ id: "AllergyStatus" });

/**
 * Point-of-care header data: photo, names, allergies, communication needs and the resuscitation
 * status (HZ-001, HZ-007, HZ-015).
 */
export const PersonSummary = z
  .object({
    id: uuid,
    locationId: uuid,
    status: z.enum([
      "enquiry",
      "active",
      "on_leave",
      "in_hospital",
      "discharged",
      "deceased",
      "archived",
    ]),
    givenName: z.string(),
    familyName: z.string(),
    preferredName: z.string().nullable(),
    dateOfBirth: isoDate.nullable(),
    nhsNumber: z.string().nullable(),
    roomLabel: z.string().nullable().meta({ description: "Room or bed at the person's location" }),
    photoUrl: z.string().nullable(),
    allergyStatus: AllergyStatus,
    allergies: z.array(
      z.object({ substance: z.string(), severity: z.string(), reaction: z.string().nullable() }),
    ),
    communicationNeeds: z.array(CommunicationNeed),
    /** The CPR decision in force, or `not_recorded` (hazard HZ-015). */
    resuscitation: ResuscitationStatus,
    version: z.number().int(),
  })
  .meta({ id: "PersonSummary" });
export type PersonSummary = z.infer<typeof PersonSummary>;

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
 * hash-chained and kept for years (security review round 4, M3); they stay on the device.
 */
export const SYNC_DISCARD_REASON_CODES = [
  "recorded_elsewhere",
  "entered_in_error",
  "staff_left",
  "nurse_in_charge_informed",
  "other",
] as const;

/**
 * Where a deletion stands (clinical review round 4, H1): `requested` is recorded before anything is
 * deleted; `deleted` only once the device has checked the entries are gone; `failed` when they
 * survived, superseding the request.
 */
export const SYNC_DISCARD_STAGES = ["requested", "deleted", "failed"] as const;

/** Most entry ids one record carries; a larger hold sends a sample and its count. */
export const SYNC_DISCARD_MAX_ENTRY_IDS = 500;

export const SyncDiscard = z
  .object({
    /** The device's tombstone id: each stage of the same deletion is recorded once. */
    id: uuid,
    kind: z.enum(SYNC_DISCARD_KINDS),
    stage: z.enum(SYNC_DISCARD_STAGES),
    reasonCode: z.enum(SYNC_DISCARD_REASON_CODES),
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
  })
  .refine((d) => d.count === null || d.entryIds.length <= d.count, {
    message: "There are more entry ids than entries.",
    path: ["entryIds"],
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

/** A device's unsent work, without personal data (HZ-006: queue depth seen by the server). */
export const SyncDeviceReport = z
  .object({
    /** Entries waiting in the upload queue. */
    unsent: z.number().int().min(0).max(1_000_000),
    /** Entries the server refused, kept on the device. */
    refused: z.number().int().min(0).max(1_000_000),
    /** Entries held after a session ended. */
    held: z.number().int().min(0).max(1_000_000),
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
  })
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
    data: z.record(z.string(), z.unknown()),
  })
  .meta({ id: "RecordVersion" });

export const RecordHistory = z
  .object({ table: z.string(), recordId: uuid, versions: z.array(RecordVersion) })
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

export * from "./care";
export * from "./care-planning";
export * from "./mca";
export * from "./records";
export * from "./safety";
export * from "./tasks";
