# Web: safeguarding, complaints and speak-up (Phase 2 slice 62)

Branch `feat/web-safety-silos`, from `feat/safety-speak-up` with `feat/safety-safeguarding-log`
merged in. Register rows SAFE-006, SAFE-011 and SAFE-012.

## What changed

- **Complaints** (`/complaints`):
  - The list is titled by when each complaint arrived, never by name, with its state as an icon
    and a word and the targets still ahead.
  - The record form, and the record with each step the workflow allows.
  - A response is refused in the form, as in the API, without the Ombudsman signposted and a kept
    copy.
  - Compliments are listed and recorded at `/complaints/compliments`.
- **Safeguarding** (`/safeguarding`):
  - The log shows each referral clock in the API's words.
  - Raising a concern is at `/safeguarding/new`.
  - The record has an update form that sends only the sections filled in, and each next step with
    what it still needs.
  - Carers get a Safeguarding measures tab on the person's record, showing the protective measures
    and never the concern (HZ-126).
- **Speak up** (`/speak-up`):
  - Named and confidential raising, and your own concerns with replies.
  - The lead's and members' cases page by cursor, and show "possible flood" in words.
  - The case view has the steps, messages and the people on the case.
  - New API route `GET /v1/speak-up/staff` (the lead only) lists active members to name on a case.
- **The anonymous page** (`/speak-up-anonymously/{organisation}`):
  - No sign-in, and a plain explanation of what anonymous means before the form.
  - No cookie and nothing in browser storage. The reply code is shown once with its last date,
    and opens replies only when typed back in, never from an address.
  - Server calls pass on only the client address, for the per-network limit.
- Navigation: Safeguarding, Complaints and Speak up, each shown only to those who may use it.
- Strings: 229 new en-GB keys (ICU, sentence case), marked untranslated in Welsh.
- Docs: `safety.md` (web screens), the feature register, and human actions H-860 to H-863.

## Tests

- `apps/web/src/lib/safety-silos.test.ts` (table-driven: chips, targets, every form reader, reply
  code shape, paging links) and `care-record.test.ts` (the new tab).
- `apps/web/e2e/safety-silos.spec.ts`, with axe in the dark and light themes on every screen:
  - the manager records and acknowledges a complaint and records a compliment;
  - the manager raises a safeguarding concern, and the carer sees only its measures;
  - the carer speaks up in confidence, the nurse (appointed lead for the run) acknowledges and
    replies, and the owner sees nothing;
  - the anonymous page sets no cookie and keeps nothing in browser storage.
- `apps/api/test/speak-up.test.ts`: the lead's staff list.

## Accessibility review fixes

The accessibility reviewer ran on the first commit, and every finding is fixed:

- The anonymity wording now says exactly what is kept: a scrambled network code for a minute,
  deleted within the hour.
- The safeguarding list and record show who the concern is about, with their communication needs
  (Accessible Information Standard).
- After a step, its form is replaced. A status region outside the form announces the result and
  focus moves to the page heading. On the public page, focus moves to the confirmation and to the
  opened thread.
- The abuse-types error has an icon. It is tied to its fieldset, marks the boxes invalid, and its
  summary link focuses the first box. The members hint is linked to its fieldset.
- Pending labels match the action ("Sending", "Opening").
- Close buttons name what they close, and say that closing is final.
- The safeguarding record shows the enquiry, the person's outcomes, the risk from staff and the
  DBS decision.
- A step that cannot be taken yet lists what it needs after "Before you can do this:".
- Speak-up cases carry a short reference, so two raised on the same day are told apart.
- Open concerns without measures are a warning notice with an icon.
- Copy fixes for the flood notice, the empty states and the reply code error.
- The anonymous page's full address is shown with a copy button.
- Playwright: all four journeys pass locally, with axe clean in both themes.
