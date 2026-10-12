import { z } from "zod";
import { PcspDomain } from "./care-planning";
import { PersonSummary } from "./person-summary";
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
    action: z.string().meta({ description: "What staff do, as the active plan words it" }),
    whenText: z.string().nullable(),
  })
  .meta({ id: "PlanActionRef", description: "The care plan action a round carries out" });
export type PlanActionRef = z.infer<typeof PlanActionRef>;

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
  })
  .meta({ id: "HandoverNoteItem" });
export type HandoverNoteItem = z.infer<typeof HandoverNoteItem>;

export const HandoverAcknowledgementItem = z
  .object({
    id: uuid,
    tenantUserId: uuid,
    itemsSeen: z.number().int(),
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
    refreshedAt: isoDateTime,
    lockedAt: isoDateTime.nullable(),
    /** Notes may still be added (until the shift ends or the handover is locked). */
    open: z.boolean(),
    itemCount: z.number().int(),
    lateAdditionCount: z.number().int(),
    /** Members of staff who have acknowledged it at least once. */
    acknowledgedBy: z.array(uuid),
    /** Of those, who has not yet acknowledged the latest late additions. */
    pending: z.array(uuid),
    /** Nobody has acknowledged it, and the shift it hands over to has started. */
    unacknowledged: z.boolean(),
    version: z.number().int(),
  })
  .meta({ id: "HandoverSummary" });
export type HandoverSummary = z.infer<typeof HandoverSummary>;

export const HandoverDetail = HandoverSummary.extend({
  /** The items the reader may see, in the order they were compiled and added. */
  items: z.array(HandoverItem),
  /** Items about people outside the reader's scope, left out (HZ-011). */
  hiddenItemCount: z.number().int(),
  notes: z.array(HandoverNoteItem),
  acknowledgements: z.array(HandoverAcknowledgementItem),
  /** The point-of-care header of each person on the visible items. */
  people: z.array(PersonSummary),
  /** Where the reader stands: acknowledged, and the items they have not yet seen. */
  you: z.object({
    acknowledged: z.boolean(),
    itemsSeen: z.number().int().nullable(),
    unseenKeys: z.array(z.string()),
  }),
}).meta({ id: "HandoverDetail" });
export type HandoverDetail = z.infer<typeof HandoverDetail>;

export const HandoverList = z
  .object({ items: z.array(HandoverSummary) })
  .meta({ id: "HandoverList" });
export type HandoverList = z.infer<typeof HandoverList>;

export const CompileHandover = z
  .object({
    /** The shift running at this time (default now); never a shift that has not started. */
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
    /** How many items the handover held when the person read it (`itemCount` as they saw it). */
    itemsSeen: z.number().int().min(0),
  })
  .meta({ id: "AcknowledgeHandover" });
export type AcknowledgeHandover = z.infer<typeof AcknowledgeHandover>;
