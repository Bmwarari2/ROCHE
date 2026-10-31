/**
 * The notice to the people affected by a personal data breach (UK GDPR Art 34; platform.md rule
 * 22; breach-response.md section 3 step 4): Harbour's plain-English template, filled from the
 * register entry, with prompts in square brackets for a person to complete. A notice still holding
 * a prompt is not ready to send. Pure; no personal data is added here.
 */

/** Each prompt starts with this, so an unfinished notice can be found. */
export const NOTICE_PROMPT = "[Write ";

export interface SubjectNoticeInput {
  /** The register entry's summary of what happened. */
  readonly summary: string;
  /** The organisation's name. */
  readonly organisation: string;
  /** Who to contact: the data protection officer or lead's name and email, if recorded. */
  readonly contactName: string | null;
  readonly contactEmail: string | null;
}

/** The draft notice, in the order the ICO asks for: what, what it means, what was done, what to do, who. */
export function subjectNoticeDraft(input: SubjectNoticeInput): string {
  const contact =
    input.contactName && input.contactEmail
      ? `${input.contactName}, ${input.contactEmail}`
      : (input.contactEmail ?? input.contactName ?? `${NOTICE_PROMPT}who to contact and how.]`);
  return [
    `We are writing to tell you about a problem with how ${input.organisation} looked after some of your information.`,
    "What happened",
    input.summary.trim(),
    "What this means for you",
    `${NOTICE_PROMPT}what this could mean for the person, in plain words.]`,
    "What we have done",
    `${NOTICE_PROMPT}what has been done to put it right and stop it happening again.]`,
    "What you can do",
    `${NOTICE_PROMPT}what the person can do to protect themselves, if anything.]`,
    "Who to contact",
    `If you have questions, or would like this in another format, contact ${contact}.`,
    "If you are unhappy with how we have handled your information, you can complain to the Information Commissioner's Office: ico.org.uk/make-a-complaint.",
  ].join("\n\n");
}

/** Whether a notice still holds one of the template's prompts (it must not be sent like that). */
export function noticeHasPrompts(notice: string): boolean {
  return notice.includes(NOTICE_PROMPT);
}
