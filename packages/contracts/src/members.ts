import { z } from "zod";

/**
 * Members of staff, as a manager holding `platform.user.manage` sees and adds them (PLAT-004;
 * platform.md, Members). Opaque ids, names, roles and states only: never an address, a sign-in or
 * anything about the people they care for. A new member is added as invited, then invited with
 * `POST /v1/invitations`.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });

export const MemberState = z.enum(["invited", "active", "suspended"]).meta({ id: "MemberState" });
export type MemberState = z.infer<typeof MemberState>;

export const MemberRole = z
  .object({
    roleId: uuid,
    roleName: z.string(),
    /** Null: across the organisation. */
    locationId: uuid.nullable(),
  })
  .meta({ id: "MemberRole" });
export type MemberRole = z.infer<typeof MemberRole>;

export const MemberSummary = z
  .object({
    id: uuid,
    displayName: z.string(),
    state: MemberState,
    /** Roles in force or starting later, newest first. */
    roles: z.array(MemberRole),
  })
  .meta({ id: "MemberSummary" });
export type MemberSummary = z.infer<typeof MemberSummary>;

/** A role the manager may give, and where (null: across the organisation). */
export const AssignableRole = z
  .object({
    id: uuid,
    name: z.string(),
    locationIds: z.array(uuid.nullable()),
  })
  .meta({ id: "AssignableRole" });
export type AssignableRole = z.infer<typeof AssignableRole>;

export const MemberList = z
  .object({ items: z.array(MemberSummary), assignableRoles: z.array(AssignableRole) })
  .meta({ id: "MemberList" });
export type MemberList = z.infer<typeof MemberList>;

export const MemberListQuery = z.object({
  /** Only members with a role at this location (or across the organisation). */
  locationId: uuid.optional(),
});

export const CreateMember = z
  .object({
    /** The client's id for the new member, kept across retries: a retry adds nobody twice. */
    id: uuid,
    displayName: z.string().trim().min(1).max(200),
    /** Their work address; stored in lower case. Never returned. */
    email: z.email().max(254),
    roleId: uuid,
    /** Null: across the organisation. */
    locationId: uuid.nullable(),
  })
  .meta({ id: "CreateMember", description: "Add a member of staff as invited, with one role" });
export type CreateMember = z.infer<typeof CreateMember>;

export const MemberCreated = z.object({ id: uuid }).meta({ id: "MemberCreated" });
export type MemberCreated = z.infer<typeof MemberCreated>;

/**
 * The member lifecycle (H-566; platform.md, Members): a holder of `platform.user.manage`, with
 * step-up and a coded reason, suspends a membership, then ends it. The member row, display name
 * and job title stay, so care records remain attributable (Regulation 17).
 */
export const MEMBER_SUSPEND_REASONS = [
  "investigation",
  "leaving",
  "account_deletion_requested",
  "long_absence",
  "other",
] as const;
export type MemberSuspendReason = (typeof MEMBER_SUSPEND_REASONS)[number];

export const MEMBER_END_REASONS = [
  "left_employment",
  "account_deletion_requested",
  "contract_ended",
  "dismissed",
  "other",
] as const;
export type MemberEndReason = (typeof MEMBER_END_REASONS)[number];

export const SuspendMember = z
  .object({
    reasonCode: z.enum(MEMBER_SUSPEND_REASONS),
    /**
     * True once the manager has been told how many entries the member's devices last reported
     * waiting: they stay on each device, protected, until a manager hands them over.
     */
    confirmEntriesWaiting: z.boolean().optional(),
  })
  .meta({ id: "SuspendMember" });
export type SuspendMember = z.infer<typeof SuspendMember>;

export const EndMember = z
  .object({ reasonCode: z.enum(MEMBER_END_REASONS) })
  .meta({ id: "EndMember" });
export type EndMember = z.infer<typeof EndMember>;

export const MembershipState = z
  .enum(["invited", "active", "suspended", "left"])
  .meta({ id: "MembershipState" });
export type MembershipState = z.infer<typeof MembershipState>;

/**
 * What happened to the person's sign-in: still in use (`kept`), kept because they still work for
 * another organisation (`kept_other_organisation`), erased, or never made (`none`).
 */
export const SignInState = z
  .enum(["kept", "kept_other_organisation", "erased", "none"])
  .meta({ id: "SignInState" });
export type SignInState = z.infer<typeof SignInState>;

export const MemberSuspended = z
  .object({
    state: MembershipState,
    /** True when the membership was already suspended: nothing changed again. */
    replay: z.boolean(),
    /** Sessions ended; 0 when the person still works for another organisation. */
    sessionsEnded: z.number().int().min(0),
    signIn: SignInState,
    /** Entries the member's devices last reported waiting, now due to be handed over. */
    entriesWaiting: z.number().int().min(0),
  })
  .meta({ id: "MemberSuspended" });
export type MemberSuspended = z.infer<typeof MemberSuspended>;

export const MemberEnded = z
  .object({
    state: MembershipState,
    replay: z.boolean(),
    signIn: SignInState,
    /** True when an account deletion request was closed with this outcome. */
    deletionRequestClosed: z.boolean(),
  })
  .meta({ id: "MemberEnded" });
export type MemberEnded = z.infer<typeof MemberEnded>;

export const MemberLifecycle = z
  .object({
    id: uuid,
    displayName: z.string(),
    jobTitle: z.string().nullable(),
    state: MembershipState,
    /** When the membership was last suspended or ended. */
    statusChangedAt: isoDateTime.nullable(),
    /** When the member asked for their account to be deleted, if they did. */
    deletionRequestedAt: isoDateTime.nullable(),
    /** True while that request is still open. */
    deletionRequestOpen: z.boolean(),
    signIn: SignInState,
    signInErasedAt: isoDateTime.nullable(),
    /** Entries the member's devices last reported waiting. */
    entriesWaiting: z.number().int().min(0),
    /** Entries the member owns on devices whose hold is still open: ending waits for them. */
    entriesToHandOver: z.number().int().min(0),
  })
  .meta({ id: "MemberLifecycle" });
export type MemberLifecycle = z.infer<typeof MemberLifecycle>;
