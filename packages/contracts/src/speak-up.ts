import { z } from "zod";
import { StaffName } from "./staff";

/**
 * Whistleblowing and speaking up (Phase 2 slice 24; safety.md Phase 2 rule 3; SAFE-012; ADR-0089).
 * A concern lives in a silo: the Freedom to Speak Up lead, the members the lead names on the case
 * and whoever raised a named or confidential concern read it, and no wider role. An anonymous
 * concern keeps no identity: its reporter holds a reply token, shown once, sent only in request
 * bodies and stored only as its SHA-256.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();
const body = z.string().trim().min(1).max(10_000);

export const SpeakUpIdentity = z
  .enum(["named", "confidential", "anonymous"])
  .meta({ id: "SpeakUpIdentity" });
export type SpeakUpIdentity = z.infer<typeof SpeakUpIdentity>;

export const SpeakUpCategory = z
  .enum([
    "care_quality_or_safety",
    "staff_safety",
    "conduct",
    "bullying_or_harassment",
    "fraud_or_finance",
    "other",
  ])
  .meta({ id: "SpeakUpCategory" });
export type SpeakUpCategory = z.infer<typeof SpeakUpCategory>;

export const SpeakUpState = z
  .enum(["received", "acknowledged", "under_review", "outcome_shared", "closed"])
  .meta({ id: "SpeakUpState" });
export type SpeakUpState = z.infer<typeof SpeakUpState>;

/** A 256-bit reply token as base64url (43 characters). */
export const SpeakUpReplyToken = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .meta({ id: "SpeakUpReplyToken" });

/** A member raising a concern with their name known: to everyone on the case, or to the lead only. */
export const RaiseSpeakUp = z
  .object({
    id: uuid.optional(),
    identity: z.enum(["named", "confidential"]),
    category: SpeakUpCategory,
    summary: z.string().trim().min(3).max(10_000),
  })
  .meta({ id: "RaiseSpeakUp" });
export type RaiseSpeakUp = z.infer<typeof RaiseSpeakUp>;

/** Anyone raising a concern with no name, on the public route. */
export const RaiseAnonymousSpeakUp = z
  .object({
    category: SpeakUpCategory,
    summary: z.string().trim().min(3).max(10_000),
    /** True for a reply token, so the lead can reply and share the outcome. */
    wantsReplies: z.boolean(),
  })
  .meta({ id: "RaiseAnonymousSpeakUp" });

export const AnonymousSpeakUpRaised = z
  .object({
    receivedOn: isoDate,
    /** Shown once and never again: Harbour keeps only its SHA-256. Null when no replies wanted. */
    replyToken: SpeakUpReplyToken.nullable(),
    /** The last UK date the token opens the concern (`speak_up.reply_token_days`). */
    replyTokenExpiresOn: isoDate.nullable(),
  })
  .meta({ id: "AnonymousSpeakUpRaised" });
export type AnonymousSpeakUpRaised = z.infer<typeof AnonymousSpeakUpRaised>;

export const SpeakUpTokenRequest = z
  .object({ replyToken: SpeakUpReplyToken })
  .meta({ id: "SpeakUpTokenRequest" });

export const AnonymousSpeakUpReply = z
  .object({ replyToken: SpeakUpReplyToken, body })
  .meta({ id: "AnonymousSpeakUpReply" });

export const SpeakUpMessage = z
  .object({
    id: uuid,
    fromReporter: z.boolean(),
    /** The member of staff who wrote it; null from the reporter, and always null for the reporter. */
    author: StaffName.nullable(),
    body: z.string(),
    createdAt: isoDateTime,
  })
  .meta({ id: "SpeakUpMessage" });
export type SpeakUpMessage = z.infer<typeof SpeakUpMessage>;

/** What whoever raised the concern sees: never who is on the case. */
export const SpeakUpThread = z
  .object({
    id: uuid,
    identity: SpeakUpIdentity,
    category: SpeakUpCategory,
    summary: z.string(),
    receivedOn: isoDate,
    state: SpeakUpState,
    outcome: z.string().nullable(),
    messages: z.array(SpeakUpMessage),
  })
  .meta({ id: "SpeakUpThread" });
export type SpeakUpThread = z.infer<typeof SpeakUpThread>;

export const SpeakUpThreadList = z
  .object({ items: z.array(SpeakUpThread) })
  .meta({ id: "SpeakUpThreadList" });
export type SpeakUpThreadList = z.infer<typeof SpeakUpThreadList>;

/** What the lead and the case's members see. */
export const SpeakUpCase = z
  .object({
    id: uuid,
    identity: SpeakUpIdentity,
    category: SpeakUpCategory,
    summary: z.string(),
    receivedOn: isoDate,
    state: SpeakUpState,
    acknowledgedAt: isoDateTime.nullable(),
    outcome: z.string().nullable(),
    outcomeSharedAt: isoDateTime.nullable(),
    closedReason: z.string().nullable(),
    closedAt: isoDateTime.nullable(),
    /** Whether the outcome can reach whoever raised it (false: anonymous with no reply token). */
    canReply: z.boolean(),
    /** Who raised it: to the lead for a named or confidential concern, to members only when named. */
    reporter: StaffName.nullable(),
    members: z.array(StaffName),
    /** The steps open to the reader now. */
    moves: z.array(SpeakUpState),
    version: z.number().int(),
  })
  .meta({ id: "SpeakUpCase" });
export type SpeakUpCase = z.infer<typeof SpeakUpCase>;

export const SpeakUpCaseDetail = SpeakUpCase.extend({
  messages: z.array(SpeakUpMessage),
}).meta({ id: "SpeakUpCaseDetail" });
export type SpeakUpCaseDetail = z.infer<typeof SpeakUpCaseDetail>;

export const SpeakUpCaseList = z
  .object({
    items: z.array(SpeakUpCase),
    /** Pass as `cursor` for the next page; null on the last. */
    nextCursor: z.string().nullable(),
    /**
     * For the lead: today's anonymous concerns reached the organisation's daily limit, so more are
     * being refused. Null otherwise, and always for a member.
     */
    possibleFlood: z.object({ count: z.number().int(), cap: z.number().int() }).nullable(),
  })
  .meta({ id: "SpeakUpCaseList" });
export type SpeakUpCaseList = z.infer<typeof SpeakUpCaseList>;

export const SpeakUpStep = z
  .object({
    to: SpeakUpState,
    version: z.number().int(),
    /** Needed to close. */
    reason: z.string().trim().max(2_000).optional(),
    /** Needed to share the outcome: what happened, in words for whoever raised it. */
    outcome: z.string().trim().min(3).max(10_000).optional(),
  })
  .meta({ id: "SpeakUpStep" });

export const SetSpeakUpMembers = z
  .object({ memberIds: z.array(uuid).max(20) })
  .meta({ id: "SetSpeakUpMembers" });

export const PostSpeakUpMessage = z.object({ body }).meta({ id: "PostSpeakUpMessage" });

export const SetSpeakUpLead = z
  .object({ tenantUserId: uuid, appoint: z.boolean() })
  .meta({ id: "SetSpeakUpLead" });

export const SpeakUpLeadChanged = z
  .object({ changed: z.boolean() })
  .meta({ id: "SpeakUpLeadChanged" });

/** Active members the lead may name on a case (the lead alone reads it). */
export const SpeakUpStaffList = z
  .object({ items: z.array(StaffName) })
  .meta({ id: "SpeakUpStaffList" });
