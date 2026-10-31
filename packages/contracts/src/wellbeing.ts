import { z } from "zod";

/**
 * Staff wellbeing and voice (scheduling.md section 16; SCHED-011). Covers pulse surveys whose
 * results show only once closed and above the minimum group size, anonymous responses, recognition
 * and wellbeing check-ins a manager sees only while shared. Nothing here scores or judges anyone.
 */

const uuid = z.uuid();
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
const version = z.number().int().min(1);

export const SurveyQuestion = z
  .object({
    id: z.string().trim().min(1).max(40),
    kind: z.enum(["scale", "free_text"]),
    text: z.string().trim().min(1).max(300),
  })
  .meta({ id: "SurveyQuestion", description: "A scale (1 to 5) or a free-text question" });

export const PulseSurveyState = z
  .enum(["draft", "open", "closed"])
  .meta({ id: "PulseSurveyState" });

export const PulseSurveyItem = z
  .object({
    id: uuid,
    locationId: uuid.nullable(),
    title: z.string(),
    questions: z.array(SurveyQuestion),
    opensOn: isoDate,
    closesOn: isoDate,
    state: PulseSurveyState,
    openedAt: isoDateTime.nullable(),
    closedAt: isoDateTime.nullable(),
    /** For a member who may answer it: whether they already have. Null for a manager's list. */
    answered: z.boolean().nullable(),
    version,
  })
  .meta({ id: "PulseSurveyItem" });

export const PulseSurveyList = z
  .object({ items: z.array(PulseSurveyItem) })
  .meta({ id: "PulseSurveyList" });

export const PulseSurveyListQuery = z.object({
  /** `manage`: the surveys at homes the reader manages; `answer` (default): those they may answer. */
  view: z.enum(["answer", "manage"]).default("answer"),
});

export const NewPulseSurvey = z
  .object({
    locationId: uuid.nullable(),
    title: z.string().trim().min(1).max(120),
    questions: z.array(SurveyQuestion).min(1).max(20),
    opensOn: isoDate,
    closesOn: isoDate,
  })
  .meta({ id: "NewPulseSurvey" });

export const EditPulseSurvey = NewPulseSurvey.omit({ locationId: true })
  .extend({ version })
  .meta({ id: "EditPulseSurvey" });

export const MovePulseSurvey = z.object({ version }).meta({ id: "MovePulseSurvey" });

export const PulseResponse = z
  .object({
    /** By question id: a whole number from 1 to 5 for a scale, text for free text. */
    answers: z.record(
      z.string().max(40),
      z.union([z.number().int().min(1).max(5), z.string().trim().min(1).max(2000)]),
    ),
  })
  .meta({ id: "PulseResponse" });

export const PulseQuestionResult = z
  .object({
    id: z.string(),
    kind: z.enum(["scale", "free_text"]),
    text: z.string(),
    /** False when fewer than the minimum group size answered this question. */
    visible: z.boolean(),
    answered: z.number().int().optional(),
    /** For a scale: how many chose each point, 1 to 5. */
    counts: z.array(z.number().int()).optional(),
    /** For free text: the answers in alphabetical order, never the order they came in. */
    texts: z.array(z.string()).optional(),
  })
  .meta({ id: "PulseQuestionResult" });

export const PulseSurveyResults = z
  .object({
    visible: z.boolean(),
    /** Why the results are hidden: still open, too few answered, or no size in force. */
    reason: z.enum(["still_open", "too_few", "no_size"]).optional(),
    minGroupSize: z.number().int().nullable(),
    respondents: z.number().int().optional(),
    questions: z.array(PulseQuestionResult).optional(),
    /** Plain words to show above the results, or instead of them. */
    message: z.string(),
  })
  .meta({ id: "PulseSurveyResults" });

export const RecognitionItem = z
  .object({
    id: uuid,
    fromMemberId: uuid,
    toMemberId: uuid,
    locationId: uuid,
    message: z.string(),
    createdAt: isoDateTime,
  })
  .meta({ id: "RecognitionItem" });

export const RecognitionList = z
  .object({ items: z.array(RecognitionItem) })
  .meta({ id: "RecognitionList" });

export const RecognitionListQuery = z.object({
  mine: z.enum(["received", "sent"]).optional(),
  locationId: uuid.optional(),
});

export const NewRecognition = z
  .object({
    toMemberId: uuid,
    /** The home where the colleague works. */
    locationId: uuid,
    message: z.string().trim().min(1).max(500),
  })
  .meta({ id: "NewRecognition" });

export const CheckInItem = z
  .object({
    id: uuid,
    memberId: uuid,
    locationId: uuid,
    mood: z.number().int().min(1).max(5),
    note: z.string().nullable(),
    sharedAt: isoDateTime.nullable(),
    createdAt: isoDateTime,
  })
  .meta({ id: "CheckInItem" });

export const CheckInList = z
  .object({
    items: z.array(CheckInItem),
    /** Where to find support: the organisation's own wording, shown with every check-in. */
    support: z.string(),
  })
  .meta({ id: "CheckInList" });

export const CheckInListQuery = z.object({
  /** For a manager: the shared check-ins at a home. Without it, the member's own. */
  locationId: uuid.optional(),
});

export const NewCheckIn = z
  .object({
    locationId: uuid,
    mood: z.number().int().min(1).max(5),
    note: z.string().trim().max(1000).nullable(),
    share: z.boolean().default(false),
  })
  .meta({ id: "NewCheckIn" });

export const ShareCheckIn = z.object({ shared: z.boolean() }).meta({ id: "ShareCheckIn" });
