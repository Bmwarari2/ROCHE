import { z } from "zod";

/**
 * E-learning courses, attempts and the runtime's messages (workforce.md section 14; ADR-0093;
 * slice 43). The postMessage protocol between the content origin's runtime and the app is
 * `ElearningRuntimeMessage` / `ElearningAppMessage`: both sides parse every message with these
 * schemas and drop anything else.
 */

const uuid = z.uuid();

export const ElearningStandard = z
  .enum(["scorm_1_2", "scorm_2004", "xapi"])
  .meta({ id: "ElearningStandard" });
export const ElearningAttemptStatus = z
  .enum(["in_progress", "completed", "passed", "failed"])
  .meta({ id: "ElearningAttemptStatus" });

export const ElearningCourseUploadQuery = z
  .object({
    title: z.string().trim().min(2).max(160),
    topic: z.string().regex(/^[a-z_]{2,60}$/),
    tier: z.coerce.number().int().min(1).max(2).optional(),
  })
  .meta({ id: "ElearningCourseUploadQuery" });

export const ElearningCourse = z
  .object({
    id: uuid,
    version: z.number().int(),
    title: z.string(),
    topic: z.string(),
    tier: z.number().int().nullable(),
    standard: ElearningStandard,
    status: z.enum(["active", "retired"]),
    fileCount: z.number().int(),
    /** The reader's own latest attempt, if any. */
    myAttempt: z
      .object({ id: uuid, status: ElearningAttemptStatus, score: z.number().nullable() })
      .nullable(),
  })
  .meta({ id: "ElearningCourse" });

export const ElearningCourseList = z
  .object({ items: z.array(ElearningCourse) })
  .meta({ id: "ElearningCourseList" });

export const ElearningLaunch = z
  .object({
    attemptId: uuid,
    courseId: uuid,
    title: z.string(),
    standard: ElearningStandard,
    status: ElearningAttemptStatus,
    /** Signed, short-lived, for this attempt only: the content origin's path segment. */
    token: z.string(),
    launchPath: z.string(),
    launchQuery: z.string(),
    /** To resume where the member left off. */
    location: z.string().nullable(),
    suspendData: z.string().nullable(),
    entry: z.enum(["ab-initio", "resume"]),
  })
  .meta({ id: "ElearningLaunch" });

export const ElearningCommit = z
  .object({
    /** SCORM data model elements, allowlisted and bounded by the API. */
    cmi: z.record(z.string().max(200), z.string().max(64000)),
    /** LMSFinish or Terminate was called: the session time counts. */
    finished: z.boolean(),
  })
  .meta({ id: "ElearningCommit" });

export const ElearningAttempt = z
  .object({
    id: uuid,
    courseId: uuid,
    workerId: uuid,
    status: ElearningAttemptStatus,
    score: z.number().nullable(),
    totalSeconds: z.number().int(),
    finishedAt: z.iso.datetime({ offset: true }).nullable(),
    trainingRecordId: uuid.nullable(),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .meta({ id: "ElearningAttempt" });

export const ElearningAttemptList = z
  .object({ items: z.array(ElearningAttempt) })
  .meta({ id: "ElearningAttemptList" });

// ------------------------------------------------------------------------------------------------
// The postMessage protocol (runtime on the content origin <-> the app)
// ------------------------------------------------------------------------------------------------

export const ELEARNING_PROTOCOL = "harbour.elearning.v1";

/** What the runtime may send the app. */
export const ElearningRuntimeMessage = z.discriminatedUnion("type", [
  z
    .object({ protocol: z.literal(ELEARNING_PROTOCOL), type: z.literal("ready"), attemptId: uuid })
    .strict(),
  z
    .object({
      protocol: z.literal(ELEARNING_PROTOCOL),
      type: z.literal("commit"),
      attemptId: uuid,
      cmi: z.record(z.string().max(200), z.string().max(64000)),
      finished: z.boolean(),
    })
    .strict(),
]);
export type ElearningRuntimeMessage = z.infer<typeof ElearningRuntimeMessage>;

/** What the app may send the runtime. */
export const ElearningAppMessage = z.discriminatedUnion("type", [
  z
    .object({
      protocol: z.literal(ELEARNING_PROTOCOL),
      type: z.literal("start"),
      attemptId: uuid,
      standard: ElearningStandard,
      launchPath: z.string().max(240),
      launchQuery: z.string().max(500),
      location: z.string().max(1000).nullable(),
      suspendData: z.string().max(64000).nullable(),
      entry: z.enum(["ab-initio", "resume"]),
      learnerId: uuid,
      learnerName: z.string().max(200),
    })
    .strict(),
  z
    .object({
      protocol: z.literal(ELEARNING_PROTOCOL),
      type: z.literal("committed"),
      attemptId: uuid,
      ok: z.boolean(),
    })
    .strict(),
]);
export type ElearningAppMessage = z.infer<typeof ElearningAppMessage>;
