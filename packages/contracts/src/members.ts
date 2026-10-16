import { z } from "zod";

/**
 * Members of staff, as a manager holding `platform.user.manage` sees and adds them (PLAT-004;
 * platform.md, Members). Opaque ids, names, roles and states only: never an address, a sign-in or
 * anything about the people they care for. A new member is added as invited, then invited with
 * `POST /v1/invitations`.
 */

const uuid = z.uuid();

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
