import { z } from "zod";
import { ResuscitationStatus } from "./care-planning";
import { PersonStatus } from "./people";

/**
 * The point-of-care header (HZ-001, HZ-007, HZ-015, HZ-023): its own module so the person list,
 * the round view and the handover share one definition without an import cycle.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();

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
 * Point-of-care header data: photo, names, allergies, communication needs, the resuscitation
 * status and the prescribed IDDSI levels (HZ-001, HZ-007, HZ-015, HZ-016).
 */
export const PersonSummary = z
  .object({
    id: uuid,
    locationId: uuid,
    status: PersonStatus,
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
    /**
     * HZ-023: `not_recorded` until someone records the needs or confirms there are none. An empty
     * list with `not_recorded` means nobody has asked, never "no needs".
     */
    communicationNeedsStatus: z.enum(["not_recorded", "none_identified", "recorded"]),
    communicationNeedsConfirmedBy: uuid.nullable(),
    communicationNeedsConfirmedAt: isoDateTime.nullable(),
    /** The CPR decision in force, or `not_recorded` (hazard HZ-015). */
    resuscitation: ResuscitationStatus,
    /**
     * HZ-016: the prescribed IDDSI food level, or `not_recorded` until someone records it, which
     * is never a normal diet: check before offering food.
     */
    iddsiFoodLevel: z.enum(["3", "4", "5", "6", "7EC", "7", "not_recorded"]),
    /**
     * HZ-016: the prescribed IDDSI drink level, or `not_recorded` until someone records it, which
     * is never thin drinks: check before offering a drink.
     */
    iddsiDrinkLevel: z.enum(["0", "1", "2", "3", "4", "not_recorded"]),
    /** When the current status began (for a discharge or death, when the person left or died). */
    statusChangedAt: isoDateTime,
    version: z.number().int(),
    /**
     * What the caller may record about this person, on `GET /v1/people/{id}` only (ADR-0071 review
     * round 2, C2-M2): `recordCare` when their care.note.write reaches the person (notes, charts
     * and body map marks); otherwise why they can only read: `break_glass` when the record is open
     * to them only by break-glass, `scope` when their roles reach the person for reading only.
     */
    access: z
      .object({
        recordCare: z.boolean(),
        readOnlyReason: z.enum(["break_glass", "scope"]).nullable(),
      })
      .optional(),
  })
  .meta({ id: "PersonSummary" });
export type PersonSummary = z.infer<typeof PersonSummary>;
