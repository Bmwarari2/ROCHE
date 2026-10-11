import { z } from "zod";

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

/** Point-of-care header data: photo, names, allergies and communication needs (HZ-001, HZ-007). */
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

export * from "./records";
export * from "./tasks";
