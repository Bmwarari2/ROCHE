import {
  type contact,
  incident,
  location,
  type person,
  role,
  roleAssignment,
  type Transaction,
  tenant,
  tenantUser,
} from "@harbour/db";
import { type MergeFieldKey, type MergeValue, toUkWallClock } from "@harbour/domain";
import { and, asc, eq, isNull } from "drizzle-orm";
import { rateNumber } from "./rates";

/**
 * The values a letter is made from (comms.md rule 24; HZ-051): every field comes from the record
 * except the few the sender types (`SENDER_TYPED_FIELDS`), each tagged with the person it belongs
 * to so `renderTemplate` can refuse another person's details. Only the fields the template uses
 * are read.
 */

/** Typed by the sender at the point of sending: admission and fee details only. */
export const SENDER_TYPED_FIELDS: ReadonlySet<string> = new Set([
  "admission.date",
  "fee.current_weekly",
  "fee.new_weekly",
  "fee.effective_date",
]);

/** The rate behind `fee.notice_days` (CMA care homes advice; never a literal). */
const FEE_NOTICE_RATE = "cma.fee_review_notice_days";

const lines = (...parts: readonly (string | null | undefined)[]) =>
  parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").join("\n");

const ukToday = () => {
  const w = toUkWallClock(new Date());
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
};

export type PersonRow = typeof person.$inferSelect;
export type ContactRow = typeof contact.$inferSelect;

export interface LetterContext {
  readonly tenantId: string;
  readonly senderId: string;
  readonly person: PersonRow;
  /** Null when the letter goes to the person themselves. */
  readonly contact: ContactRow | null;
  readonly incidentId: string | null;
  readonly typed: Readonly<Record<string, string | number>>;
}

/**
 * A posted letter's page-1 blocks (comms.md section 11; H-228): the provider's letterhead from its
 * branding (the name it trades under, its registered name when that differs, and the address and
 * telephone number of the person's home, which sends the letter) and the recipient's name and
 * address for the window envelope (a contact's address, or the person's own, as the merge field
 * `recipient.address` reads them). Missing parts are left out, never invented.
 */
export async function letterBlocks(
  tx: Transaction,
  ctx: Pick<LetterContext, "tenantId" | "person" | "contact">,
): Promise<{ letterhead: string[]; address: string[] }> {
  const [t] = await tx
    .select({ name: tenant.name, legalName: tenant.legalName, brandName: tenant.brandName })
    .from(tenant)
    .where(eq(tenant.id, ctx.tenantId));
  const [l] = await tx.select().from(location).where(eq(location.id, ctx.person.locationId));
  const split = (text: string) => (text ? text.split("\n") : []);
  const shown = t?.brandName?.trim() || t?.name || "";
  const registered = t?.legalName?.trim() ?? "";
  const letterhead = [
    shown,
    ...(registered && registered !== shown ? [registered] : []),
    ...split(l ? lines(l.addressLine1, l.addressLine2, l.town, l.postcode) : ""),
    ...(l?.phone ? [`Telephone ${l.phone}`] : []),
  ].filter((line) => line !== "");
  const p = ctx.person;
  const c = ctx.contact;
  const address = [
    c ? `${c.givenName} ${c.familyName}` : `${p.givenName} ${p.familyName}`,
    ...split(
      c
        ? lines(c.addressLine1, c.town, c.postcode)
        : lines(p.addressLine1, p.addressLine2, p.town, p.postcode),
    ),
  ];
  return { letterhead, address };
}

export async function letterValues(
  tx: Transaction,
  ctx: LetterContext,
  fields: readonly MergeFieldKey[],
): Promise<Record<string, MergeValue>> {
  const used = new Set<string>(fields);
  const values: Record<string, MergeValue> = {};
  const own = (value: string | number | null | undefined) =>
    value === null || value === undefined ? null : { value, personId: ctx.person.id };
  const general = (value: string | number | null | undefined) =>
    value === null || value === undefined ? null : { value, personId: null };
  const put = (key: string, value: MergeValue | null) => {
    if (used.has(key) && value !== null) values[key] = value;
  };

  for (const key of SENDER_TYPED_FIELDS) {
    if (used.has(key) && Object.hasOwn(ctx.typed, key)) put(key, own(ctx.typed[key]));
  }
  if (used.has("tenant.name")) {
    const [t] = await tx
      .select({ name: tenant.name })
      .from(tenant)
      .where(eq(tenant.id, ctx.tenantId));
    put("tenant.name", general(t?.name));
  }
  if ([...used].some((k) => k.startsWith("location."))) {
    const [l] = await tx.select().from(location).where(eq(location.id, ctx.person.locationId));
    put("location.name", general(l?.name));
    put(
      "location.address",
      general(l ? lines(l.addressLine1, l.addressLine2, l.town, l.postcode) || null : null),
    );
    put("location.phone", general(l?.phone));
  }
  put("letter.date", general(ukToday()));
  if (used.has("sender.name") || used.has("sender.role")) {
    const [s] = await tx
      .select({ name: tenantUser.displayName })
      .from(tenantUser)
      .where(eq(tenantUser.id, ctx.senderId));
    const [r] = await tx
      .select({ name: role.name })
      .from(roleAssignment)
      .innerJoin(role, eq(role.id, roleAssignment.roleId))
      .where(and(eq(roleAssignment.tenantUserId, ctx.senderId), isNull(roleAssignment.deletedAt)))
      .orderBy(asc(role.name), asc(role.id))
      .limit(1);
    put("sender.name", general(s?.name));
    put("sender.role", general(r?.name ?? "Member of staff"));
  }
  const p = ctx.person;
  put("person.full_name", own(`${p.givenName} ${p.familyName}`));
  put("person.preferred_name", own(p.preferredName ?? p.givenName));
  put("person.room", own(p.roomLabel));
  put("person.date_of_birth", own(p.dateOfBirth));
  put("person.nhs_number", own(p.nhsNumber));
  const c = ctx.contact;
  put(
    "recipient.full_name",
    own(c ? `${c.givenName} ${c.familyName}` : `${p.givenName} ${p.familyName}`),
  );
  put(
    "recipient.address",
    own(
      (c
        ? lines(c.addressLine1, c.town, c.postcode)
        : lines(p.addressLine1, p.addressLine2, p.town, p.postcode)) || null,
    ),
  );
  if (used.has("fee.notice_days")) {
    put("fee.notice_days", general(await rateNumber(tx, ctx.tenantId, FEE_NOTICE_RATE)));
  }
  if (ctx.incidentId && (used.has("incident.date") || used.has("incident.summary"))) {
    const [i] = await tx
      .select({
        occurredAt: incident.occurredAt,
        description: incident.description,
        people: incident.personIds,
      })
      .from(incident)
      .where(and(eq(incident.id, ctx.incidentId), isNull(incident.deletedAt)));
    // Tagged with the incident's own people: one about someone else is refused as wrong_person.
    const about = i?.people.includes(p.id) ? p.id : (i?.people[0] ?? "another-person");
    if (i) {
      const w = toUkWallClock(i.occurredAt);
      put("incident.date", {
        value: `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`,
        personId: about,
      });
      put("incident.summary", { value: i.description, personId: about });
    }
  }
  return values;
}
