import { z } from "zod";
import { CarePlanStatus, PcspDomain } from "./care-planning";
import { PersonSummary } from "./person-summary";
import { StaffName } from "./staff";
import { TaskItem } from "./tasks";

/**
 * Rounds and the shift handover (care.md rules 8 and 14; register rows CARE-013 and COMMS-006).
 * Handover items are references to records, never their text; every stop on a round carries the
 * point-of-care header (HZ-001). Times are ISO 8601 with offset.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });

export const ShiftWindow = z
  .object({
    name: z.string().meta({ description: "The shift's name in the location's pattern" }),
    start: isoDateTime,
    end: isoDateTime.meta({ description: "Exclusive" }),
  })
  .meta({ id: "ShiftWindow" });
export type ShiftWindow = z.infer<typeof ShiftWindow>;

// ------------------------------------------------------------------------------------------------
// Round view
// ------------------------------------------------------------------------------------------------

export const PlanActionRef = z
  .object({
    actionId: uuid,
    planId: uuid,
    publishedVersion: z.number().int().nullable(),
    domain: PcspDomain,
    action: z.string().meta({ description: "What staff do, as the plan words it" }),
    whenText: z.string().nullable(),
    /** The status of the plan the action belongs to; anything but active is an earlier plan. */
    planStatus: CarePlanStatus,
    /**
     * "From an earlier plan: check the current plan" when the action is no longer in the active
     * plan (an overdue round stays open to be done; HZ-024); null while it is.
     */
    notice: z.string().nullable(),
  })
  .meta({ id: "PlanActionRef", description: "The care plan action a round carries out" });
export type PlanActionRef = z.infer<typeof PlanActionRef>;

export const NotARound = z
  .object({
    actionId: uuid,
    domain: PcspDomain,
    action: z.string().meta({ description: "What staff do, as the active plan words it" }),
    whenText: z.string().nullable(),
    /** "Not a round: see the medicines record" (HZ-003). */
    notice: z.string(),
  })
  .meta({
    id: "NotARound",
    description:
      "An action of the person's active plan that generates no rounds (medicines, until the eMAR), listed so the round never reads as the whole of their care",
  });
export type NotARound = z.infer<typeof NotARound>;

export const RoundTask = TaskItem.extend({
  /** For a care plan round, the action it carries out; null for any other task. */
  planAction: PlanActionRef.nullable(),
}).meta({ id: "RoundTask" });
export type RoundTask = z.infer<typeof RoundTask>;

export const RoundStop = z
  .object({
    personId: uuid.nullable(),
    roomLabel: z.string().nullable(),
    /** The point-of-care header (HZ-001, HZ-007, HZ-015); null for tasks about no person. */
    person: PersonSummary.nullable(),
    tasks: z.array(RoundTask),
    /** The person's active plan actions that are not rounds: see the medicines record (HZ-003). */
    notRounds: z.array(NotARound),
  })
  .meta({ id: "RoundStop" });
export type RoundStop = z.infer<typeof RoundStop>;

export const RoundArea = z
  .object({
    area: z
      .string()
      .nullable()
      .meta({ description: "Floor or unit; null for people with no room" }),
    stops: z.array(RoundStop),
  })
  .meta({ id: "RoundArea" });

export const RoundView = z
  .object({
    locationId: uuid,
    shift: ShiftWindow,
    from: isoDateTime,
    to: isoDateTime,
    /** When the server read it: a copy kept offline shows its age (HZ-002). */
    readAt: isoDateTime,
    taskCount: z.number().int(),
    /**
     * False when the location has more open tasks than one view lists (2,000, the oldest first):
     * ask for a shorter window, and never read the view as the whole round.
     */
    complete: z.boolean(),
    areas: z.array(RoundArea),
  })
  .meta({ id: "RoundView" });
export type RoundView = z.infer<typeof RoundView>;

// ------------------------------------------------------------------------------------------------
// Handover
// ------------------------------------------------------------------------------------------------

export const HandoverItemKind = z
  .enum([
    "fall",
    "news2",
    "incident",
    "alert",
    "body_map_mark",
    "flagged_note",
    "overdue_task",
    "skipped_task",
    "unfinished_task",
    "must_follow_up",
    "refusal",
  ])
  .meta({
    id: "HandoverItemKind",
    description: "In order of how urgently the next shift needs it",
  });

export const HandoverSourceType = z
  .enum(["task", "observation", "incident", "body_map_mark", "care_note", "notification"])
  .meta({ id: "HandoverSourceType" });

export const HandoverItem = z
  .object({
    key: z.string(),
    kind: HandoverItemKind,
    personId: uuid.nullable(),
    sourceType: HandoverSourceType,
    sourceId: uuid,
    at: isoDateTime.meta({ description: "When it happened, or when the task fell due" }),
    lateAddition: z.boolean(),
    addedAt: isoDateTime,
    /**
     * What the item says, as a catalogue key (`handover.summary.*`) and its parameters: codes
     * (a NEWS2 band and score, a chart, an incident type, an alert kind, a mark's type, view,
     * region and side) and, for a task, its title and why it was not done. Word it in the
     * reader's language from the key; null on items compiled before summaries existed.
     */
    summary: z
      .object({
        key: z.string(),
        params: z.record(z.string(), z.union([z.string(), z.number()])),
      })
      .nullable(),
    /** Whether the reader has already acknowledged it. */
    seen: z.boolean(),
  })
  .meta({ id: "HandoverItem" });
export type HandoverItem = z.infer<typeof HandoverItem>;

export const HandoverNoteItem = z
  .object({
    id: uuid,
    itemKey: z.string().nullable(),
    personId: uuid.nullable(),
    body: z.string(),
    createdAt: isoDateTime,
    createdBy: uuid.nullable(),
    /** The note's author by name and job title. */
    createdByStaff: StaffName.nullable(),
  })
  .meta({ id: "HandoverNoteItem" });
export type HandoverNoteItem = z.infer<typeof HandoverNoteItem>;

export const HandoverAcknowledgementItem = z
  .object({
    id: uuid,
    tenantUserId: uuid,
    /** Who acknowledged, by name and job title. */
    staff: StaffName.nullable(),
    acknowledgedAt: isoDateTime,
  })
  .meta({ id: "HandoverAcknowledgementItem" });
export type HandoverAcknowledgementItem = z.infer<typeof HandoverAcknowledgementItem>;

export const HandoverSummary = z
  .object({
    id: uuid,
    locationId: uuid,
    shift: ShiftWindow,
    compiledAt: isoDateTime,
    /**
     * When it last changed as you see it: the last item you can see joining it, or its last
     * refresh when you see it whole.
     */
    refreshedAt: isoDateTime,
    lockedAt: isoDateTime.nullable(),
    /** Notes may still be added (until the shift ends or the handover is locked). */
    open: z.boolean(),
    /**
     * True when you see only the items about people you may see (HZ-011): every count and list
     * here is then over those items and your own acknowledgements.
     */
    limitedToYourPeople: z.boolean(),
    /** The items you can see. */
    itemCount: z.number().int(),
    /** Of those, the ones added after it was first compiled. */
    lateAdditionCount: z.number().int(),
    /** Members of staff who have acknowledged it at least once (only you, when limited). */
    acknowledgedBy: z.array(uuid),
    /** Of those, who has items they can see still to acknowledge (only you, when limited). */
    pending: z.array(uuid),
    /** The members in `acknowledgedBy` and `pending`, by name and job title. */
    staff: z.array(StaffName),
    /**
     * True once the shift has ended and nobody on the incoming shift has acknowledged everything
     * they can see (an acknowledgement before the shift ended does not count); null when limited.
     */
    unacknowledged: z.boolean().nullable(),
    /**
     * When the incoming shift's acknowledgement is late: the shift's end plus
     * `handover.acknowledgement_grace_minutes`, the time the nurse in charge is alerted (H-410);
     * null when the figure cannot be read, so nothing is called overdue on a guess.
     */
    acknowledgementDueAt: isoDateTime.nullable(),
  })
  .meta({ id: "HandoverSummary" });
export type HandoverSummary = z.infer<typeof HandoverSummary>;

export const HandoverDetail = HandoverSummary.extend({
  /** The items the reader may see, in the order they were compiled and added. */
  items: z.array(HandoverItem),
  notes: z.array(HandoverNoteItem),
  acknowledgements: z.array(HandoverAcknowledgementItem),
  /** The point-of-care header of each person on the visible items. */
  people: z.array(PersonSummary),
  /** Where the reader stands: acknowledged, and the items they have not yet seen. */
  you: z.object({
    acknowledged: z.boolean(),
    acknowledgedAt: isoDateTime.nullable(),
    unseenKeys: z.array(z.string()),
    /**
     * Send this back to acknowledge the handover as you see it here; it changes whenever an
     * item you can see is added, and an acknowledgement with an old one is refused.
     */
    seenToken: z.string(),
  }),
}).meta({ id: "HandoverDetail" });
export type HandoverDetail = z.infer<typeof HandoverDetail>;

export const HandoverList = z
  .object({ items: z.array(HandoverSummary) })
  .meta({ id: "HandoverList" });
export type HandoverList = z.infer<typeof HandoverList>;

export const CompileHandover = z
  .object({
    /**
     * The shift running at this time (default now); never a shift that has not started, nor one
     * from before the offline window (`mobile.offline_window_days` and a day).
     */
    at: isoDateTime.optional(),
  })
  .meta({ id: "CompileHandover" });
export type CompileHandover = z.infer<typeof CompileHandover>;

export const CreateHandoverNote = z
  .object({
    /** A device-generated UUIDv7, so a retried save is recorded once (HZ-029). */
    id: uuid.optional(),
    /** The item the note is about; omit for a note on the whole handover. */
    itemKey: z.string().min(1).max(300).optional(),
    body: z.string().trim().min(1).max(2000),
  })
  .meta({ id: "CreateHandoverNote" });
export type CreateHandoverNote = z.infer<typeof CreateHandoverNote>;

export const AcknowledgeHandover = z
  .object({
    /** A device-generated UUIDv7, so a retried acknowledgement is recorded once. */
    id: uuid.optional(),
    /**
     * The `you.seenToken` of the handover as the person read it. The server records the items
     * they could see itself, and refuses an old token (409) so nobody acknowledges items they
     * have not been shown.
     */
    seenToken: z.string().min(1).max(128),
  })
  .meta({ id: "AcknowledgeHandover" });
export type AcknowledgeHandover = z.infer<typeof AcknowledgeHandover>;
