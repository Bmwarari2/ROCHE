---
status: "proposed"
date: 2026-10-11
decision-makers: Claude Code (build); DPO to accept (H-99)
consulted: security-reviewer agent
informed: Brian
---

# Personal data in template emails: none in subjects, no special category data in bodies

## Context and problem statement

COMMS-007 (master prompt 15.1) sends merge-field letters and emails: admission letters, fee
reviews, incident follow-ups and duty of candour letters. Notifications already leave Harbour with
generic titles only (`outboundTitleProblem`, platform.md), but a letter to a family member has to
name the person and say what it is about. Email to arbitrary family addresses is delivered with
opportunistic TLS at best, is kept in mailboxes Harbour cannot reach, and its subject shows in
previews and on lock screens. What personal data may a template email carry?

## Decision drivers

- UK GDPR Article 5(1)(f) and Article 32: security appropriate to special category data.
- The person's and family's expectation that health details are not sent where others may see them.
- Families still need ordinary letters (fee reviews, admission details) without friction.
- A rule the template checker can enforce before approval, not a judgement at send time.

## Considered options

- Classify every merge field; email subjects take no personal data; email bodies take personal but
  not special category data; special category content goes by letter (post, by hand or the portal).
- Allow any field in email and rely on transport security.
- Never put personal data in email: every email is a generic notice with a link into the portal.

## Decision outcome

Chosen option: "classify fields; no personal data in subjects; no special category data in email
bodies", because it keeps health and care details out of email while letting ordinary
correspondence work.

1. Every merge field has a data class (`none`, `personal`, `special_category`) in `MERGE_FIELDS`;
   incident and candour details are special category.
2. `checkTemplateDefinition` refuses an email template whose subject uses any personal field or
   whose body uses a special category field; letters may use any field.
3. Rendering lists the personal-data fields used, for the "check before sending" screen and the
   audit trail, and the subject must also pass `outboundTitleProblem`.
4. Duty of candour and incident follow-up templates are letters only (`LETTER_ONLY_KINDS`): they
   cannot be set up as email at all. Email may carry a generic notice that a letter is waiting in
   the portal (slice 12 onwards).
5. Added after the security review: the NHS number and date of birth (`notInEmail`) never go in an
   email body, because together with a name they identify the person outright; a subject may not
   use a multi-line field (an address, the incident summary) or hold a character that can break or
   disguise a header (C0 and C1 controls, U+2028, U+2029, bidirectional controls), checked on the
   template and again on the rendered subject (`hasUnsafeHeaderCharacter`).

### Consequences

- Good, because health details never sit in a family member's inbox through Harbour.
- Good, because the rule is checked at approval, so a template cannot be used wrongly later.
- Bad, because a family that prefers email gets candour letters by post or through the portal; the
  portal arrives for families in slice 12 (feed) and Phase 4 (documents to sign).
- Neutral, because the data classes are Harbour's reading and the DPO may move a field (H-99).

### Confirmation

`packages/domain/src/comms/templates.test.ts` ("personal data in an email subject", "health details
in an email", "refuses an email subject that would carry personal details"). The API step's
`comms.email` guard keeps checking titles before sending.

## Pros and cons of the options

### Classify fields, restrict subjects and special category data

- Good, because it matches the sensitivity of the data to the channel.
- Bad, because the classification needs maintaining as fields are added.

### Allow any field in email

- Good, because it is simplest for families.
- Bad, because special category data would sit in third-party mailboxes and previews.

### Generic emails with portal links only

- Good, because no personal data leaves by email at all.
- Bad, because families without portal access (most in Phase 1) would get nothing useful by email.

## More information

Related: [comms.md](../specs/comms.md) rules 3 and 7, platform.md (notification centre), hazard
HZ-051, records of processing. Revisit when the family portal delivers documents (Phase 4).
