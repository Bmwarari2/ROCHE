# Communication and portals (`comms`) - specification

Master prompt section 15.1 (communication and portals) with the 15.3 communications integrations,
section 4 (the "Family / representative" role: one person; updates, consented sections of the care
plan, visit booking; attorneys see finance where their power covers it), section 5.1 (consent
covers only optional processing such as photos in the family portal), section 8 (plain English at
reading age 9 on family surfaces) and section 17 for offline behaviour. Phase 1 builds letter and
email templates with approval (slice 11) and the family feed with the communications integrations
(slice 12); handover acknowledgement (COMMS-006) is specified and built with the handover in
[care.md](care.md) rule 8 (slice 5: `POST /v1/locations/{id}/handovers/{handoverId}/acknowledgements`,
the append-only `handover_acknowledgement` table, which records the keys of the items the reader
could see when they sent the seen token of the view they were shown, and refuses an old token; the
late-addition notice and the alert to the nurse in charge when nobody on the incoming shift has
acknowledged by `handover.acknowledgement_grace_minutes`, both staff notifications, never family
ones). The person's portal, professional access, messaging and the public site
arrive in Phase 4. Status per feature lives in the [feature register](feature-register.md).

## 1. Purpose and register rows

A family member or representative sees everyday updates about one person, and the care plan
sections they are entitled to, only while a recorded sharing decision allows it; is told there is
something new without the message saying what; and can book a visit. Phase 1 slice 12 built the
spec and the domain rules. The schema, API, web and mobile steps follow (section 11).

Letters and emails that matter (an admission letter, a fee review, an incident follow-up, a duty of
candour letter) say the right things about the right person, in words someone with authority has
approved, and never put health details where they do not belong.

| Phase 1 rows | Later rows |
| --- | --- |
| COMMS-007 letter and email templates with approval (slice 11); COMMS-001 family portal and app mode (slice 12): updates feed and consented care plan sections; INTG-011 communications (SES email, SMS gateway, Expo push, ICS calendar, click-to-call): domain side and ports only, adapters behind mocks and contract tests; COMMS-006 handover acknowledgement (care.md) | COMMS-002 visit booking (its domain rule is built early here, rule 17), messaging, invoices, surveys, complaints and documents to sign (Phase 4); COMMS-003 the person's own portal; COMMS-004 professional access; COMMS-005 internal messaging (Phase 4); COMMS-008 (Phase 4) |

The family feed builds on the sharing rules in [people.md](people.md) rule 13 and
`packages/domain/src/people/sharing.ts`; it never decides on its own who may see a section.

PLAT-009 (document store) names "merge-field templates": this spec is where they are defined; a
rendered letter is stored as a document about the person.

## 2. Schema

To be added in the schema step (expand only; slices 11 and 12 change no database table). All
tables carry `id` (UUIDv7), `tenant_id`, `created_at`, `created_by` and forced RLS. Staff reach
rows about a person through `app.person_in_scope`; family members reach only the rows section 2.1
allows (ADR-0002, ADR-0061).

| Table | Kind | Key columns | Retention class |
| --- | --- | --- | --- |
| `feed_item` | append-only | person, kind (`FEED_ITEM_KINDS`), section, care plan domain, source kind and id, occurred at, composed at, text, photo document, phrase key, composed by, confirmed by and reason (rule 12), `supersedes_item_id`, other-people-identifiable attestation (photos) | `care_record` |
| `feed_item_withdrawal` | append-only | item, reason (`FEED_WITHDRAWAL_REASONS`), by, at | `care_record` |
| `care_note_share` | append-only | care note, the words written for the family, marked by, marked at (rule 8; the clinical note is never copied) | `care_record` |
| `feed_view` | append-only | item, person, contact, decision, section, care plan domain, person status, capacity for sharing, viewed at (the exposure history, rule 4) | `audit_event.care_record` |
| `family_portal_user` | mutable | tenant user, contact (the link a family session is resolved from; ADR-0061) | `care_record` (with the contact) |
| `family_channel` | mutable, versioned | contact, kind (`email`, `sms`, `push`), address (email, E.164 number or push token), verified at, updates on, opted out at and how, suspended at and why | `care_record` (with the contact); push tokens deleted at sign-out |
| `family_notification` | mutable | contact, person, notification id, status (`planned`, `held`, `sent`, `failed`, `cancelled`), deliver at, the feed items it covers (ids), template key and version per channel; deliveries use the platform's `notification_delivery` | follows the record it relates to (`care_record`); shorter period for the DPO to set (H-106) |
| `family_notification_setting` | mutable | contact, own quiet hours (start and end, UK time) | `care_record` (with the contact) |
| `visit_booking` | mutable, versioned | person, contact, start, end, status (`confirmed`, `cancelled`), sequence (for the calendar file), cancelled by and reason, review flag (rule 17) | `care_record` |
| `visit_booking_setting` | mutable, versioned | location, online booking hours (start and end minute, UK time), visits at once | tenant configuration |
| `location_visit_restriction` | mutable, versioned | location, kind (`outbreak`, `other`), from, to, reason (staff only) | `care_record` |
| `letter_template` | mutable | name, kind (`TEMPLATE_KINDS`), channel (`letter`, `email`), current approved version | `organisation_document` |
| `letter_template_version` | mutable while draft, then fixed | template, version, state (`TEMPLATE_WORKFLOW`), name, subject (email), body, author, contributors, approved by and at, retirement reason | `organisation_document` |
| `letter` | append-only | template version, person, recipient (the person or one of their contacts), channel, the personal-data fields used, whether it holds special category data, results to follow (candour), incident and its grade (incident and candour letters), rendered document (PDF for letters; for email, the delivery and the document), sent by and at, delivery reference | `letterRetentionClass`: `serious_incident` for an incident or candour letter about an incident graded serious, otherwise `care_record` |

Templates are tenant configuration with no personal data; rendered letters follow the person they
are about (slice 11).

CHECK constraints for the schema step (the domain also refuses these, fail-closed):
`kind = 'care_plan_update'` requires `care_plan_domain`; `photo_document_id` is set only when
`kind = 'photo'`; `section` equals `FEED_ITEM_SECTIONS[kind]`; a confirmation reason is set with
its confirmer.

Columns other modules add in their schema steps: `sharing_decision` gains suspension periods
(`sharing_decision_suspension`: from, to, reason; built in people migration 0025 as `suspended_at`
and `lifted_at`) and, for deputies, the sections the order covers
(people.md rule 13); `best_interests_decision` gains `decision_kind` (`CONSENT_DECISION_KINDS`)
and, for `photos`, a yes or no outcome (rule 6); `care` adds a standing visit restriction (who it
applies to, from, to, reason) beside the per-visit restriction in `visit_log`, and an
accompaniment purpose on `visit_log` (`ACCOMPANIMENT_PURPOSES`, rule 7); `safety` exposes whether
an incident's next of kin still have to be told (rule 12); tenant settings gain the staff-name rule
for family updates (`first_name_only` or `full_name`) and the portal address used in notification
links.

New personal data fields are mapped in [data-standards.md](data-standards.md) (sections
[packs and governance](data-standards.md#packs-and-governance-phase-1-slice-11) and
[family feed](data-standards.md#family-feed-and-communications-phase-1-slice-12)) and listed in the
[records of processing](../compliance/records-of-processing.md).

### 2.1 Family scope and row-level security (schema-step requirement, ADR-0061)

The domain cannot test row-level security, so these are requirements on the schema step, listed in
the feature register against COMMS-001.

- Family members get no `person_assignment` and no staff role. A portal session is resolved from
  portal roles only (`resolveAccess(..., "portal")`): no grants, no person scope (`app.scope` is
  `none`), and `app.family_contact_ids` set from `family_portal_user`. So `app.person_in_scope`,
  and through it `app.person_visible`, is false for every person: a family session reaches no
  person, contact, care, people or safety table.
- Feed tables carry a restrictive policy that, for a family session, calls a sharing-decision
  function instead of the person scope:

  ```sql
  CREATE POLICY feed_item_family ON public.feed_item AS RESTRICTIVE
    FOR SELECT TO harbour_app
    USING (
      (app.current_scope() <> 'none' AND app.person_visible(person_id))
      OR app.family_can_see(person_id, section, care_plan_domain, occurred_at)
    );
  -- app.family_can_see: SECURITY DEFINER, owned by a NOLOGIN role, SET search_path = pg_catalog,
  -- public; true only when tenant_id = app.current_tenant_id(), a contact in
  -- app.family_contact_ids() is the recipient of a sharing_decision for that person that covers
  -- the section (and domain), was in force and not suspended at occurred_at, is in force and not
  -- suspended now, has a lapsed authority false, meets the capacity rule (people.md rule 13), and
  -- the person's status is active, on_leave or in_hospital. It mirrors checkFeedItemVisibility.
  ```

- Family-owned rows (`family_channel`, `family_notification_setting`, `visit_booking`) carry a
  policy `contact_id = ANY (app.family_contact_ids())` for family sessions, with WITH CHECK on
  inserts; `visit_booking` inserts also need `app.family_can_see(person_id,
  'activities_and_visits', NULL, now())`.
- Isolation tests (in `packages/db/test`, named `hazard HZ-022` or `hazard HZ-011`): a family
  session sees no row of any table with `person_id` other than the feed and its own rows (the test
  enumerates the tables); feed rows only for its own contact's decisions, never another contact's,
  another person's or another tenant's; a withdrawn, suspended, expired or lapsed decision hides
  the rows at the next query; rows from before a decision or during a suspension stay hidden; a
  discharged or deceased person's rows are hidden; a family session cannot insert or update
  `feed_item`, `sharing_decision` or any staff table; a staff session's feed rows follow the person
  scope; `app.family_can_see` cannot be called across tenants and has a fixed search path; no
  portal user holds a `person_assignment` (a constraint or trigger); the CHECK constraints above.
- The family app mode (MOB-004, Phase 4) needs its own sync streams with the same rule, tested on
  their own because replication bypasses RLS.

## 3. Permissions

From the catalogue in `packages/domain/src/platform/permissions.ts` (matrix:
[permissions.md](permissions.md)). Family permissions act on the one person the family member's
contact is linked to; staff permissions follow the person's scope. Every read and write is audited.

| Permission | Care record (MFA) | Allows | Held by (built-in roles) |
| --- | --- | --- | --- |
| `comms.template.write` | no | Write and change draft letter and email templates | Owner, Registered Manager, deputy, quality lead, administrator |
| `comms.template.approve` | no | Approve a version (not one you wrote or edited), supersede or retire one | Owner, Registered Manager, deputy, quality lead |
| `comms.letter.manage` | no | Make and send letters and emails from approved templates; also needs `people.person.read` or `people.demographics.read`, in scope, for every person-bound field merged | Owner, Registered Manager, deputy, administrator |
| `comms.feed.read` | yes | Read the family feed and the care plan sections a sharing decision opens | Family or representative |
| `comms.feed.publish` | yes | Mark a note as shareable and write it for the family, choose photos, publish updates, and confirm flagged words with a reason (rule 12) | Owner, Registered Manager, deputy, clinical lead, team leader |
| `comms.feed.withdraw` | yes | Take an update down with a reason | Owner, Registered Manager, deputy, clinical lead, team leader |
| `comms.notification.subscribe` | no | Add, verify and switch off their own email, mobile number and app notifications, and set their own quiet hours | Family or representative |
| `comms.notification.manage` | no | See delivery problems (bounces, complaints, opt-outs) and the location's notification settings | Owner, Registered Manager, deputy, administrator |
| `comms.visit_booking.request` | no | Ask to book a visit online | Family or representative |
| `comms.visit_booking.manage` | no | See, review and cancel bookings, set online booking hours and limits | Owner, Registered Manager, deputy, administrator |

`comms.feed.read` touches care records, so a family member reading the feed needs MFA (a passkey or
TOTP), as section 5.3 requires of every role that reads care records. Portal-only permissions
(`PORTAL_ONLY_PERMISSIONS`: the portal, feed read, notification subscribe and visit request) are
enforced in code: `checkRoleDefinition` refuses a role that mixes them with staff permissions,
`checkGrantPermissions` refuses them in grants, and `resolveAccess` gives a staff session none of
them and a portal session nothing else (`packages/domain/src/platform/access.ts`). Existing
tenants' role copies gain the new permissions through a data migration in the schema step.

Duty of candour and incident letters also need `safety.incident.manage` for the incident (the API
checks it when it fills the `incident.*` and `candour.*` fields).

## 4. Rules that are easy to get wrong

Every rule has a table-driven test in `packages/domain/src/comms/` (named with its hazard ID where
one applies). Figures come from `rate_table` by key: the family notification figures resolved with
`resolveCommsRates`, and `fee.notice_days` in a template filled from `cma.fee_review_notice_days`
by the caller.

### The feed: who sees what (COMMS-001, HZ-022)

1. **Closed by default** (`feed-visibility.ts`). Each update belongs to one section of the record
   (`FEED_ITEM_SECTIONS`: activities and visits to `activities_and_visits`, appointments to
   `appointments`, shared notes to `daily_updates`, photos to `photos`, care plan updates to
   `care_plan` with the domain, finance statements to `finance`). A family member sees it only when
   `checkSectionVisibility` (people/sharing.ts) finds a decision in force for that person, that
   section (and care plan domain) and that recipient: the family contact the decision names, and
   for a legal authority the contact who holds it. With no decision nothing is shown. An update
   about another person is never shown (`wrong_person`). Data that should never exist is hidden
   too: a care plan update with no section (`care_plan_domain_missing`), and a photo attached to
   another kind of update unless the photos section is open and the photo basis holds.
2. **A decision covers only its own time.** Only decisions in force, and not suspended, when the
   thing happened count (`decisionInForceAt`), so updates from before a decision, from a gap
   between a withdrawal and a later decision, or from a suspension (for example during a
   safeguarding enquiry) stay closed even after the suspension is lifted
   (`before_decision_start`, `suspended_when_it_happened`). Suspensions are stored as periods. A
   manager who wants earlier updates shared sets the decision's start earlier, which is recorded.
3. **The lifecycle closes the feed.** The feed is open only while the person is receiving care
   (`LIVE_PERSON_STATUSES`: active, on leave, in hospital, from people/lifecycle.ts). Discharge and
   death close sharing (people.md rules 2 and 13, the `close_sharing` effect); a correction of a
   discharge or death recorded in error does not reopen it until a manager reinstates the decision.
   Nothing new is composed for a closed record. A family member who had a decision then sees
   "Updates are paused. The home will be in touch." (`FEED_PAUSED_STATEMENT`, wording for the CSO,
   H-110), never a feed that is suddenly empty; someone who never had a decision sees no change. A
   death or a discharge is never announced through the feed or a notification: staff tell the
   family in person or by phone.
4. **Withdrawal hides from then on; what was seen stays seen.** Withdrawing or suspending a decision
   closes its sections at the next request. It cannot undo a view, so every view is kept
   (`feed_view`, with the decision that allowed it and the capacity finding then): `feedExposure`
   lists what the family member saw under a decision and when first, for the withdrawal screen, a
   DSAR and the breach register, and lists any view made after the decision closed as a breach
   candidate. An update taken down (`checkFeedWithdrawal`: a known reason, who, when, once)
   disappears for anyone who had not seen it; a family member who had seen it sees only "This update
   was taken down because it was not right." (HZ-061). A corrected update names the one it replaces.
   A notification still waiting for a withdrawn update is re-checked and cancelled if nothing is
   left to tell (rule 15).
5. **Attorneys, deputies and appointees see what their authority covers**, enforced by the sharing
   rules the feed calls: a health and welfare attorney or personal welfare deputy may be shown care
   sections only while the person lacks capacity for the sharing decision now (the feed passes the
   current finding; without one capacity is presumed and such a decision stays closed,
   `capacity_regained`); the same holds for a representative's consent and a best-interests
   decision. A deputy acts only within the sections their order covers, which are recorded with the
   authority. A property and financial affairs attorney or property and affairs deputy sees finance
   only (a typed placeholder, `finance_statement`, until Phase 3); a DWP appointee sees benefits
   matters only (the `benefits` section), never finance statements. A decision that names a
   section outside the authority is never honoured, and an authority past its end date closes the
   feed (`authority_lapsed`). The person may still choose to share updates with an attorney under
   their own consent; that is a separate decision.
6. **Photos need their own lawful basis** (`feedPhotoBasis`). Consent is the basis for this
   optional processing (master prompt 5.1, records of processing B8): the person's own consent, or
   that of a representative whose authority covers the decision (care/mca/consent.ts). Where an
   assessment shows the person lacks capacity to decide about photos, a recorded best-interests
   decision in favour, following that assessment, is the alternative. A refusal stops photos
   whatever else is recorded; an overdue capacity or best-interests review stops them until
   reviewed. A photo is composed only when one member of staff chose it and only the person can be
   recognised in it. When the basis ends, photo updates (and any update carrying a photo) are taken
   down at once (`photoItemsToWithdraw`): families no longer see them, the records stay in the care
   record under `care_record` as the history of what was shared, and copies a family member saved
   cannot be recalled.

### The feed: what it says (COMMS-001)

7. **Approved phrasing** (`feed-compose.ts`, `FEED_PHRASES`). Activities, finished visits, planned
   appointments, photos, care plan updates and finance statements become fixed sentences. They say
   what happened, never how the person is, and carry no visitor's name and no restriction. Not
   composed: "not able to join" an activity (the reason may be about health); a visit still under
   way; an accompaniment without its recorded purpose, or one for an unplanned appointment or an
   emergency (`ACCOMPANIMENT_PURPOSES`), which the family hears by phone; an update to a care plan
   section the allow-list keeps out of the feed (`FEED_CARE_PLAN_DOMAINS`: end of life, medicines,
   skin, continence, cognition, mood, behaviour, pain, breathing and sexuality and relationships
   are never announced; the CSO confirms the list, H-110). The section itself stays visible to
   whoever a decision allows. Observations, charts, assessments, validated tool results, body
   maps, medicines and incidents have no feed kind at all.
8. **Shared notes** only when a member of staff has marked the note as shareable and written the
   words for the family (`care_note_share`); the clinical note itself never passes through.
9. **Third parties are stripped.** Staff-written words (shared notes, photo captions, activity
   names) are normalised first (`normaliseFeedText`: Unicode NFKC, invisible format characters
   such as zero-width spaces, joiners, soft hyphens and direction controls removed) and lookalike
   Cyrillic and Greek letters are folded for matching (`foldLookalikes`). They are refused when
   they name another resident: full names (with given, preferred or known-as first names) and
   surnames in any case; first names alone with their capital, unless the person shares them. They
   are refused when they carry an email address (including a full-width at sign) or a run of ten
   or more digits across spaces, points, hyphens or brackets (an NHS or phone number). When the
   tenant's rule is `first_name_only`, staff full names in any case become first names and a staff
   surname left on its own is refused.
10. **No scores, diagnoses or prognoses** (medical-device boundary). Staff-written words are
    refused when they contain a term from `FEED_CLINICAL_TERMS`: the validated tools (NEWS2, MUST,
    Waterlow, Braden and the others the boundary names) and "score"; diagnosis and condition words;
    prognosis words; clinical measurements; medicines. Each part of a hyphenated word is checked
    ("COVID-19", "anti-depressants", "pre-diabetic") and plural and possessive endings are removed
    ("UTIs", "sores"). "MUST" is matched in capitals, and "must" in any case beside score,
    screening, screen, risk or result; "Must" alone in mixed case is not refused, because it opens
    ordinary sentences and refusing it would teach staff to ignore the check. It is a backstop
    behind the staff member's decision to share, not a complete list; no confirmation overrides it.
11. **Reading age about 9, as a lint** (`feedReadabilityLint`). Sentences over 15 words and words
    over 12 letters are named for the writer (`FEED_READABILITY_LINT`, Harbour writing defaults,
    not statutory). It never blocks an update and there is no readability score. The approved
    phrases pass it (care plan section names are fixed labels and are not linted).
12. **Stale or misleading updates** (HZ-061). Every entry shows when the thing happened, and when it
    was written if that was on a later UK day; the feed shows when the newest update happened and
    always says: "These are everyday updates. They are not the full care record. The home will
    phone you about anything important." Ordering is newest first by when it happened. Staff words
    that announce an event (`FEED_EVENT_TERMS`: a fall, a hospital or A&E visit, an ambulance, a
    death, a stroke, an injury, safeguarding, the police, a missing person and similar) or claim how
    the person is (`FEED_WELLBEING_TERMS`: settled, happy, fine, well, comfortable, no concerns and
    similar) are refused unless a member of staff holding `comms.feed.publish` confirms with a
    reason of at least `FEED_CONFIRMATION_MIN_REASON_LENGTH` characters; the update records who
    confirmed and why. Nothing is published for the person while they are in hospital, while an
    incident waits for their next of kin to be told, or while a duty of candour step is open
    (`feedPublishingHolds`, read from the safety records); the family hears these things from a
    person first.

### Notifications (INTG-011, HZ-060)

13. **Content-free by construction** (`notify-plan.ts`). A notification says only that there is
    something new and links to the updates page (`familyUpdatesLink`: the tenant's https portal
    origin and `/family/updates`, with no id, name, query or fragment). The planner is given the
    ids of the new updates, never their content. The words are the latest approved template for the
    channel (approval is COMMS-007); a template is refused when it is not approved or is withdrawn,
    holds a placeholder, fails the outbound guard (`outboundTitleProblem`: NHS numbers, dates,
    email addresses, phone numbers, more than 80 characters), contains a clinical, event or
    wellbeing term, or names the person in any case or lookalike letters. Adapters check the title
    again before sending.
14. **Channels, opt-in, bounces and opt-outs** (`channels.ts`, ADR-0060). Email, SMS and push go
    through the `comms.email`, `comms.sms` and `comms.push` ports. A channel carries updates only
    when verified, switched on by the family member (off by default), not opted out and not
    suspended (any suspension, even one stored without its reason). Providers' reports become
    provider-neutral events: a permanent bounce or undeliverable SMS, a spam complaint, or an
    unregistered device suspends the channel until the address changes; a temporary bounce is
    retried; STOP (and the usual variants) by SMS, an email unsubscribe link or the portal opts out
    at once; START from the same phone or the portal opts back in. Addresses are checked for shape
    (email with the shared printable-ASCII check also used for letters, so a lookalike letter is
    refused; E.164 for SMS); proof comes from verification. Click-to-call offers only the home's own number
    as a `tel:` link.
15. **Quiet hours and one notification at a time.** Family updates are never urgent, so quiet hours
    always apply: the tenant's window (`comms.family_notifications.quiet_start_minute` to
    `.quiet_end_minute`, UK time, tenant setting) and the family member's own, if set, both hold a
    notification until the first moment neither does, on the UK clock across clock changes
    (`quietHoursRelease`; both occurrences of a time in the repeated autumn hour are considered,
    HZ-009). While a notification waits, new updates join it rather than starting another. Before a
    held notification goes, and when an update it covers is taken down, its updates are checked
    again (`recheckPendingNotification`); with nothing left it is cancelled. Retries use the
    integration framework's backoff and an idempotency key per delivery.
16. **Calendar files for visits** (`notify-calendar.ts`, RFC 5545). Downloaded from the portal after
    sign-in, never attached to a message. CRLF lines folded at 75 octets without splitting a
    character; TEXT escaped; DTSTAMP in UTC; start and end in Europe/London local time with
    `TZID=Europe/London` and a VTIMEZONE (RFC 5545 forbids a TZID on a UTC value), except an instant
    in the repeated hour after the clocks go back, which is written in UTC so it cannot be read as
    the earlier hour (`ukWallClockOccurrences`). A cancellation keeps the UID, raises SEQUENCE and
    sets STATUS:CANCELLED. The entry names the home, never the person.

### Visit booking (COMMS-002, built early)

17. **Online booking is a convenience, never a gate** (`visit-booking.ts`; Regulation 9A). A
    request is checked in an order that reveals least: the end after the start and the start not
    passed; then the sharing decision for `activities_and_visits` (before the person's status), the
    person being at the home, no standing restriction on all visitors or this visitor, and no
    restriction on the whole location (an outbreak); then one UK day, the location's online booking
    hours (UK clock; no product default, so online booking is off until a location sets them) and
    the visits-at-once limit. Every refusal about the person, the decision or a restriction reads
    the same, "We cannot book this visit online. Please call the home to arrange it.", so it never
    reveals a hospital stay, leave, a safeguarding suspension, an outbreak or a restriction's
    reason; the refusal code and restriction id are typed `staffOnly`. Booking hours limit online
    booking, not visiting. Whenever the person's status changes (a hospital admission or leave as
    well as a discharge or death), a decision changes or a restriction is added, confirmed future
    bookings are re-checked (`visitBookingsToReview`): staff phone the family, and the portal shows
    "The home needs to speak to you about this visit. Please call the home." How the nominated
    visitor is treated during restrictions is the tenant's Regulation 9A policy (H-111).

### Letter and email templates (COMMS-007, HZ-051)

18. **Typed merge fields** (`MERGE_FIELDS`). Each field has a type (`text`, `date`, `datetime`,
    `money` in whole pence, `number`), a data class (`none`, `personal`, `special_category`) and
    whether it belongs to one person receiving care (`personBound`: the person's own details, a
    contact's details, their fees, incidents and candour details). Incident and candour details are
    special category data. Three flags say where a field may go: `multiLine` (addresses, the
    incident summary and the candour texts can run over several lines), `notInEmail` (the NHS
    number and date of birth identify the person outright) and `allowsResultsToFollow` (only
    `candour.results`).
19. **Syntax** (`parseTemplateText`). Fields are written `{{field.name}}` (lower case, digits,
    underscores and dots). An unclosed field, a stray `}}`, a malformed name or a field not in the
    catalogue is refused with the field named. The parser is a loop, not a regular expression, so
    it cannot backtrack on long input (the CodeQL ReDoS gate); bodies are limited to
    `MAX_TEMPLATE_BODY_LENGTH` characters.
20. **Where personal data may go** (`checkTemplateDefinition`; ADR-0051).
    - An email needs a subject of at most `MAX_TEMPLATE_SUBJECT_LENGTH` characters that uses only
      fields with no personal data (subjects show in inbox previews and notifications) and no
      `multiLine` field (a line break in a subject is a header break).
    - The subject may not hold a character that can break or disguise an email header
      (`hasUnsafeHeaderCharacter`): C0 and C1 control characters (CR and LF among them), DEL,
      U+2028 and U+2029, and the bidirectional controls (U+061C, U+200E, U+200F, U+202A to U+202E,
      U+2066 to U+2069). The check runs on the template and again on the rendered subject, after
      the values are merged (rule 24).
    - Incident follow-up and duty of candour letters are letters only (`LETTER_ONLY_KINDS`): they
      cannot be email templates at all.
    - A special category field never goes in an email body, and nor does a `notInEmail` field (NHS
      number, date of birth); such content goes as a letter (by post, by hand or through the
      portal). Other personal fields may go in an email body and are flagged.
21. **Required content and the relevant person.** A duty of candour letter must contain the
    written notification's contents from regulation 20(4) of the 2014 Regulations: the account of
    the facts (`candour.account`, 20(4)(a)), the enquiries to be made (`candour.enquiries`, (b)), the
    results of further enquiries (`candour.results`, (c)) and an apology (`candour.apology`, (d)).
    - **Results to follow.** The first notification usually comes before the enquiries end, so
      `candour.results` alone may take a `results_to_follow` marker with an optional expected date.
      It prints standard words (`resultsToFollowText`): "The results of our further enquiries are
      not available yet. We will write to you with them by dd/mm/yyyy." The rendered letter carries
      `resultsToFollow`, and the API step keeps the candour record's "enquiries and results shared"
      step ([safety.md](safety.md) schema) open until a letter without the marker is sent. A blank
      `candour.results` is still refused.
    - **Who receives it** (`checkCandourRelevantPerson`). Regulation 20(7): the relevant person is
      the service user or, on their death, where they are under 16 and not competent, or where they
      are 16 or over and lack capacity in relation to the matter, a person lawfully acting on their
      behalf. A representative recorded without one of those bases is refused
      (`representative_basis_not_met`), and so is the service user when one applies
      (`representative_required`). A candour letter renders only for the relevant person on the
      candour record: the service user, or that representative as one of the person's contacts
      (`candour_recipient_required`, `candour_wrong_recipient`). Harbour's reading, to confirm with
      the CSO and a solicitor (H-103).
22. **Approval and separation of duties** (`checkTemplateApproval`, `TEMPLATE_WORKFLOW`). Only a
    draft with no problems, that differs from the approved version, approved by a holder of
    `comms.template.approve` who neither wrote nor edited it (`checkTemplateEdit` adds every editor
    to the contributors).
23. **Versions** (`startTemplateRevision`, `currentApprovedTemplate`). An approved version never
    changes; any change is a new draft that needs approval again, and until then the approved version
    stays in use. Approving the new version supersedes the old; a template can be retired with a
    reason.
24. **Rendering** (`renderTemplate`):
    - only an approved version renders (HZ-051);
    - every field used needs a value of its type; a missing or blank value refuses the letter rather
      than leaving a gap (HZ-051);
    - every person-bound value must belong to the person the letter is about, and a recipient must
      be that person's contact; otherwise the letter is refused (HZ-051);
    - values are formatted in British style (dd/mm/yyyy, 24-hour UK time, pounds and pence);
    - for HTML email every value and every piece of the template's own text is escaped
      (`escapeHtml`), paragraphs become `<p>` and line breaks `<br>`; nothing in a template or value
      can inject markup;
    - the rendered email subject is checked again for header-breaking characters (a value could
      carry one) and must pass the outbound title check (`outboundTitleProblem`);
    - a letter's text goes to the PDF renderer (Typst) as data, never as markup: values and template
      text are passed as strings the template prints, so nothing typed can run as Typst code;
    - a duty of candour letter needs the candour record's relevant person and the recipient, and
      they must match (rule 21);
    - the result lists the personal-data fields used and whether special category data is present,
      for the "check before sending" screen and the audit trail.
25. **Before sending** (the API step). The sender sees the person's name and photo (HZ-001), the
    recipient, and the flagged personal-data fields, and confirms; the letter, the template version
    and the fields used are stored and audited.
26. **Plain English** (`templateStyleWarnings`, optional and advisory). Sentences over
    `MAX_SENTENCE_WORDS` words, capitals used for emphasis (acronyms such as CQC and NHS excepted) and
    title-case template names are pointed out; nothing is blocked.

### Domain modules (slices 11 and 12)

`packages/domain/src/comms/`, exported from `@harbour/domain`; pure functions with no I/O:

| Module | Main exports | For |
| --- | --- | --- |
| `templates.ts` | `MERGE_FIELDS`, `TEMPLATE_KINDS`, `LETTER_ONLY_KINDS`, `TEMPLATE_REQUIRED_FIELDS`, `parseTemplateText`, `hasUnsafeHeaderCharacter`, `checkTemplateDefinition`, `TEMPLATE_WORKFLOW`, `checkTemplateApproval`, `checkTemplateEdit`, `startTemplateRevision`, `currentApprovedTemplate`, `CANDOUR_REPRESENTATIVE_BASES`, `checkCandourRelevantPerson`, `resultsToFollowText`, `renderTemplate`, `formatMergeValue`, `escapeHtml`, `letterRetentionClass` | Rules 18 to 25 |
| `template-style.ts` | `templateStyleWarnings`, `MAX_SENTENCE_WORDS`, `TEMPLATE_ACRONYMS` | Rule 26 |
| `feed-visibility.ts` | `FEED_ITEM_KINDS`, `FEED_ITEM_SECTIONS`, `FEED_CARE_PLAN_DOMAINS`, `checkFeedItemVisibility`, `buildFamilyFeed`, `feedPhotoBasis`, `feedExposure`, `FEED_NOT_FULL_RECORD_STATEMENT`, `FEED_WITHDRAWN_NOTICE`, `FEED_PAUSED_STATEMENT` | Rules 1 to 7 and 12 |
| `feed-compose.ts` | `FEED_SOURCE_KINDS`, `FEED_PHRASES`, `ACCOMPANIMENT_PURPOSES`, `composeFeedItem`, `checkFeedText`, `feedPublishingHolds`, `stripStaffSurnames`, `checkFeedWithdrawal`, `photoItemsToWithdraw` | Rules 4 and 6 to 12 |
| `feed-text.ts` | `normaliseFeedText`, `foldLookalikes`, `feedWords`, `feedSentences`, `feedReadabilityLint`, `FEED_CLINICAL_TERMS`, `FEED_EVENT_TERMS`, `FEED_WELLBEING_TERMS`, `findFeedTerms`, `findClinicalTerms`, `findConfirmationTerms`, `findNameMentions`, `hasEmailLikeText`, `longestDigitRun` | Rules 9 to 13; loops only, no unbounded regular expression over user text |
| `channels.ts` | `FAMILY_CHANNEL_KINDS`, `FAMILY_CHANNEL_PORTS`, `familyChannelUsability`, `applyFamilyChannelEvent`, `classifySmsReply`, `toE164`, `checkFamilyChannelAddress`, `clickToCallLink` | Rule 14 |
| `notify-plan.ts` | `planFamilyNotification`, `checkFamilyNotificationTemplate`, `currentFamilyTemplate`, `familyUpdatesLink`, `quietHoursRelease`, `isValidQuietHours`, `recheckPendingNotification` | Rules 13 and 15 |
| `notify-rates.ts` | `COMMS_RATE_KEYS`, `resolveCommsRates`, `familyQuietHours`, `minuteOfDayToHhMm` | Rule 15 figures |
| `notify-calendar.ts` | `buildIcsCalendar`, `checkIcsEvent`, `escapeIcsText`, `foldIcsLine`, `icsDateTimeProperty`, `EUROPE_LONDON_VTIMEZONE` | Rule 16 |
| `visit-booking.ts` | `checkVisitBooking`, `visitBookingsToReview`, `VISIT_CALL_THE_HOME`, `VISIT_BOOKING_NEEDS_A_CALL`, `visitBookingCalendarEvent` | Rule 17 |

Changed outside `comms` for slice 12: `people/sharing.ts` (appointees and `benefits`, deputy order
sections, the current capacity finding, suspension periods, `decisionInForceAt`) and
`platform/access.ts` and `roles.ts` (portal-only permissions enforced, portal sessions).

## 5. API and events

For the API step. Family routes under `/v1/family/...` act on the person the caller's contact is
linked to, in a portal session (`resolveAccess(..., "portal")`): `GET /v1/family/feed` (calls
`buildFamilyFeed`, writes one `feed_view` per entry and an audit event; `no-store`),
`GET /v1/family/care-plan` (sections the decisions open), `GET`/`POST`/`DELETE
/v1/family/channels` with `POST .../verify`, `PUT /v1/family/quiet-hours`,
`POST /v1/family/visit-bookings`, `GET .../{id}/calendar.ics`, `POST .../{id}/cancel`. Staff
routes: `POST /v1/people/{id}/feed` (compose and publish from a source record, with an optional
confirmation; returns problems and the lint), `POST /v1/feed-items/{id}/withdraw`,
`GET /v1/people/{id}/feed/exposure?decision=`, `GET /v1/locations/{id}/visit-bookings` (with the
bookings to review), `PUT /v1/locations/{id}/visit-booking-settings`,
`POST /v1/locations/{id}/visit-restrictions`, `GET /v1/family-notifications/problems`. Provider
webhooks (SES bounce and complaint notifications, the SMS gateway's delivery receipts and replies,
Expo push receipts) are inbound integrations: validated, quarantined on failure, translated into
`FamilyChannelEvent`.

Audit events: `comms.feed.viewed`, `comms.feed.item_published` (with the confirmer and reason
when given), `comms.feed.item_withdrawn`, `comms.feed.publish_refused` (problem codes only),
`comms.notification.planned`, `comms.notification.held`, `comms.notification.sent`,
`comms.notification.cancelled`, `comms.notification.failed`, `comms.channel.suspended`,
`comms.channel.opted_out`, `comms.channel.opted_in`, `comms.channel.verified`,
`comms.channel.address_changed`, `comms.visit_booking.requested`, `comms.visit_booking.refused`
(reason code; the restriction id for staff only), `comms.visit_booking.confirmed`,
`comms.visit_booking.review_needed`, `comms.visit_booking.cancelled`, `comms.calendar.downloaded`.
Audit payloads carry opaque ids and codes, never update text, addresses or names.

Outbox events published: `comms.feed.item_published` (the notification worker plans per family
member), `comms.visit_booking.confirmed`, `comms.visit_booking.cancelled`. Consumed:
`people.sharing.changed` (recompute; re-check waiting notifications and future bookings),
`people.person.went_to_hospital`, `people.person.went_on_leave`, `people.person.discharged` and
`people.person.died` (re-check waiting notifications and future bookings), and the safety events
that open or close an incident's next-of-kin contact or a candour step (the publishing hold).
`care.note.recorded` is not consumed: sharing a note is a deliberate staff action.

Letter and email templates (for the schema and API step; none of this is built in slice 11):

- `GET` and `POST /v1/letter-templates`, `GET /v1/letter-templates/{id}/versions`,
  `POST .../versions` (a new draft from the approved one), `PUT .../versions/{versionId}` (drafts
  only), `POST .../versions/{versionId}/approve`, `.../retire`, `GET /v1/merge-fields`.
- `POST /v1/people/{id}/letters/preview` (renders, returns the flags; nothing stored),
  `POST /v1/people/{id}/letters` (renders, stores the document, sends email through the
  `comms.email` port or marks a letter printed), `GET /v1/people/{id}/letters`.
- Audit events: `comms.template.drafted`, `.approved`, `.retired`; `comms.letter.previewed`,
  `comms.letter.sent` (template version, person, recipient, fields used, never the content).
- Outbox events: `comms.letter.sent` (safety links a candour letter to the candour record's written
  notification step).

## 6. Offline behaviour (section 17.1)

| Data | On the device | Writes offline | Conflict handling |
| --- | --- | --- | --- |
| Family feed (web portal, Phase 1) | Nothing: the portal is online only, `no-store` | No | Not applicable |
| Family app mode (MOB-004, Phase 4) | Only items whose sections a decision opens, through family sync streams tested on their own (replication bypasses RLS, HZ-022) | No | Not applicable; the last sync time shows (HZ-061) |
| Sharing a note or choosing a photo (Care mode) | Online only in Phase 1 | No | Not applicable |
| Letter and email templates and letters | Nothing: online-only office tasks | No | Not applicable |

## 7. Clinical safety

Hazards touched: HZ-022 (a section shown without a sharing decision; the feed's causes, controls
and tests are added to it), HZ-009 (UK clock for quiet hours, booking hours and calendar files),
and new with this spec HZ-060 (health details in an email, SMS or push notification) and HZ-061
(family reassured by a stale or misleading update, proposed residual level 3 until the CSO reviews
it). HZ-002 covers staff on offline devices and is not the same hazard. See the
[hazard log](../clinical-safety/hazard-log.md).

HZ-051 (a letter or email carries another person's details, or wrong or unapproved content) is new
with this spec. Its controls include the person check on every person-bound value, approval by a
second person, letter-only kinds, identifiers kept out of email, header-safe subjects, the candour
recipient check and the "results to follow" words that keep the follow-up due (rules 20, 21 and 24).
HZ-001 applies to the "check before sending" screen. Duty of candour letters relate to HZ-013
through the candour clock in [safety.md](safety.md).

Medical-device boundary: templates merge recorded values and add no clinical content; the feed
composes fixed sentences and staff-written words; it has no kind for observations, scores or
assessments, refuses words that read as a score, diagnosis or prognosis, and interprets nothing.
Notifications carry no clinical content
([medical-device-boundary.md](../compliance/medical-device-boundary.md)).

## 8. Data protection and data standards

The tenant is the controller and Thapsus the processor. Updates and photos shared with family are
optional processing under consent (records of processing B8), or under the basis of a legal
authority or best-interests decision (H-38, H-106); the care record itself never rests on consent.
Contacting family members about updates they asked for is B2 and B8; the exposure history is B5.
Retention classes as in section 2 and [retention.md](retention.md): withdrawing photo consent takes
photo updates down at once, while the feed items and the photo documents stay in the care record
under `care_record` as the history of what was shared. New personal data: family channel addresses
(email, mobile number, push token) with verification, opt-out and bounce state; notification and
delivery logs (address, template, status, provider message id; never content); feed views;
confirmation reasons; photo consent and best-interests outcomes for photos; visit bookings and
location restrictions. Sub-processors: Amazon SES (family email), a UK-only SMS gateway and, for
the family app mode, Expo push with APNs and FCM (United States; safeguard to confirm, H-112) are
pending entries in [sub-processors.md](../compliance/sub-processors.md) (H-105). No personal data
leaves in a message body beyond the recipient's own address.

Templates hold no personal data. Rendered letters hold the person's and their contact's data and,
for incident and candour letters, special category data; they are disclosures to the recipient
under the purpose of the record they relate to (B1 or B2; candour letters B7). Email is used only
for content without special category data or identifiers such as the NHS number and date of birth
(ADR-0051, for the DPO to accept, H-99). Recipient addresses are printable ASCII only, lower-cased
without Unicode case-folding, so two different addresses cannot be treated as one. Retention:
templates `organisation_document`; letters `care_record`, or `serious_incident` for an incident or
candour letter about an incident graded serious (`letterRetentionClass`, [retention.md](retention.md)).
Field mapping: [data-standards.md](data-standards.md#packs-and-governance-phase-1-slice-11).

## 9. Acceptance criteria and tests (written before code)

- Domain (built): `feed-visibility.test.ts` (HZ-022: closed by default, every hidden reason, the
  lifecycle and the paused feed, decision start, gaps and suspensions, withdrawal notice,
  attorneys, deputies and appointees with the current capacity finding, photo basis, data that
  should never exist, exposure), `feed-compose.test.ts` and `feed-compose-review.test.ts` (phrases
  over every announced section, shareable notes, third parties in any case, hidden characters and
  lookalike letters, clinical terms, the reviewer's event and wellbeing examples, confirmation,
  publishing holds, accompaniments and visits under way, the care plan allow-list, photos, closed
  records, withdrawal), `feed-text.test.ts` and `feed-text-review.test.ts`, `channels.test.ts`,
  `notify-plan.test.ts` (HZ-060, templates, link, channels, quiet hours across both clock changes
  and in the repeated hour, re-checking, rate table), `notify-calendar.test.ts`,
  `visit-booking.test.ts` (refusals, identical messages, decision before status, outbreaks,
  re-checking bookings, UK clock), `feed-permissions.test.ts`; outside comms
  `people/sharing-scope.test.ts` and `platform/access-portal.test.ts`.
- Domain (built, slice 11): `packages/domain/src/comms/templates.test.ts` (catalogue; parsing and
  hostile input; definition checks; header-unsafe characters and multi-line fields in subjects;
  letter-only kinds; identifiers kept out of email; candour contents, results to follow and the
  relevant person; approval and separation of duties; edits and versions; rendering, escaping and
  formatting; HZ-051 wrong person, missing values and unapproved versions; letter retention;
  permissions), `packages/domain/src/comms/template-style.test.ts` and
  `packages/domain/src/shared/email.test.ts`.
- Database (schema step): section 2.1 (family scope, `app.family_can_see`, the isolation tests and
  CHECK constraints); RLS coverage and HZ-011 isolation for every new table; append-only grants for
  `feed_item`, `feed_item_withdrawal`, `care_note_share` and `feed_view`.
- Database (templates): RLS for the new tables; fixed approved versions; append-only `letter`.
- API: `hazard HZ-022 the family feed returns nothing without a sharing decision in force`;
  withdrawal and suspension close the feed on the next request; every view writes `feed_view`;
  portal sessions resolved with `resolveAccess(..., "portal")`; `hazard HZ-060` adapters refuse a
  non-generic title; webhook events update channels; contract tests for the SMS mock and the SES
  and Expo adapters; audit events for every route.
- API (templates): `hazard HZ-051 a letter cannot be made with another person's details`; email
  delivery through the guarded `comms.email` port, which refuses a header-unsafe subject again; a
  Typst render test with a value full of Typst syntax that prints as text; audit without content.
- Web and mobile: Playwright family journey (sign in with MFA, empty feed without a decision, feed
  after a decision, withdrawn notice, paused feed, quiet hours setting, visit booking and calendar
  download) with axe; staff journey (mark a note shareable, see problems and lint, confirm flagged
  words with a reason, publish, withdraw).
- Web (templates): Playwright journeys (author, approve by another user, preview with flags, send)
  with axe.

## 10. Open questions

- The DPO accepts ADR-0051 (no special category data or identifiers in email bodies) and the data
  classes of the merge fields (H-99).
- The CSO and a solicitor confirm the "results to follow" wording and Harbour's reading of the
  relevant person under regulation 20(7) (H-103).
- Starter templates (admission, fee review, incident follow-up, duty of candour) need wording
  reviewed by the provider's adviser; Harbour ships the fields, not legal wording.
- Welsh-language versions of a template (Phase 7) will be a second body per version.
- The lawful basis for sharing photos and updates under a best-interests decision or a legal
  authority (H-38, H-106) and the photo consent wording (H-106).
- The care plan sections announced in the feed, the paused-feed wording, the event and wellbeing
  word lists and the confirmation and hold rules (H-110).
- The nominated visitor during visiting restrictions (Regulation 9A policy, H-111).
- The transfer safeguard for family push tokens (H-112).
- Group activity photos where other residents can be recognised are refused; sharing them would
  need each person's own basis and is left for a later decision.
- The readability lint limits (15 words, 12 letters) and the approved phrases need review with
  families (H-109).
- Tenant defaults: quiet hours 21:00 to 08:00, staff first names only, no online booking hours
  until set (H-107).
- The SMS gateway (H-09, H-105); NHS Notify only if social-care eligibility is confirmed (master
  prompt 6).
- Standing visit restrictions are not yet recorded in `care` (rule 17 takes them as input).

## 11. As built

Slice 11 (domain rules): `templates.ts` and `template-style.ts` in `packages/domain/src/comms/`,
exported from `@harbour/domain`; pure functions with no I/O. No schema, API or web changes in
that slice.

Slice 12 (domain only): the eight feed and notification modules in section 4 with table-driven
tests, revised after the clinical and security review; the sharing changes in `people` and the
portal session rules in `platform`; the comms permissions in the catalogue and roles; the
quiet-hours rows in [rates.md](rates.md). Not built here, by design: schema (including section 2.1,
which is a schema-step requirement), API, web and mobile (other slices are changing them), and the
adapters (SES and Expo exist from Phase 0; the SMS adapter is a mock until H-105). The feed's photo
rule reads `consent_record` and `capacity_assessment` through the care rules, and a best-interests
decision about photos through `PhotoBestInterestsView` until the care schema adds the decision kind
and outcome. The publishing hold reads `FeedIncidentView` and candour states until safety exposes
the next-of-kin contact. The template type here (`FamilyNotificationTemplate`) is what the planner
reads; the API maps the COMMS-007 approved template to it.

Slice 11 (letter and email templates, schema: migration 0059; `feat/comms-letter-templates`):
`packages/db/src/schema/comms.ts`.

| Table | Built as |
| --- | --- |
| `letter_template` | Mutable, versioned. Kind and channel fixed once made; a letter-only kind (`LETTER_ONLY_KINDS`) cannot be an email template (CHECK). `current_version_id`, the approved version in use, is set only by the version workflow (approval puts a version in use; retirement takes it out). Read by holders of `comms.template.write`, `.approve` or `comms.letter.manage` anywhere in the organisation; made by holders of write. No personal data |
| `letter_template_version` | Mutable while a draft, then fixed. Starts as a draft in its author's name, numbered next; a subject exactly when the template is an email; one draft and one approved version per template. A draft's editors join its contributors; approval by a holder of approve who is neither author nor contributor, of content that differs from the version in use, supersedes it inside the same trigger. Retired with a reason by a holder of approve; a draft discarded with a reason by a holder of write |
| `letter` | Append-only. Follows its person (`app.person_visible`); made in the sender's name by a holder of `comms.letter.manage` at the person's location, only from an approved version and on its template's channel; to the person or one of their own contacts (a composite key to `contact` by person); a letter's document is one of the person's own; no special category data in an email (CHECK); the incident and its grade come from the incident itself (only on an incident follow-up or candour letter, and only an incident about this person; serious when its retention is `serious_incident` or its harm severe or fatal), and `retention_class` follows (`serious_incident` or `care_record`). Out of reach of an evidence pack link session. Holds the personal-data field keys used, never an email's content |

Tests: `packages/db/test/letter-templates.test.ts`; the RLS coverage test lists `letter` as
append-only; the export catalogue describes every column. The API (template routes, preview and
sending, the PDF and the email body) follows.

Slice 11 (letter and email templates, API part 2a; `feat/comms-letter-templates-api`):
`apps/api/src/routes/letter-templates.ts`, contracts in `packages/contracts/src/letters.ts`.

| Route | Built as |
| --- | --- |
| `GET /v1/merge-fields` | The catalogue (`MERGE_FIELDS`) with each field's type, data class and where it may go; holders of `comms.template.write`, `.approve` or `comms.letter.manage` |
| `GET /v1/letter-templates`, `GET .../{id}/versions` | Each template with the version in use and its open draft (or every version, newest first), each with its problems in words (`checkTemplateDefinition`), the personal-data fields it uses and plain-English suggestions (`templateStyleWarnings`) |
| `POST /v1/letter-templates` | Write: a template with its first draft; a letter-only kind as email is refused (422) before the database refuses it too; a draft with problems is saved and they are listed; `comms.template.drafted` |
| `POST .../versions`, `PUT .../versions/{versionId}`, `.../discard` | Write: a new draft from the version in use (one at a time, 409), changes to a draft against the loaded version (the editor joins the contributors), discarding with a reason; `.drafted`, `.edited`, `.discarded` |
| `POST .../versions/{versionId}/approve`, `.../retire` | Approve: `checkTemplateApproval` (not the author or an editor, no problems, different from the version in use), then the database's guard; the old version superseded; retiring with a reason takes the template out of use; `.approved`, `.retired` |

Audit rows hold ids and codes only, never typed reasons (H-223). The email port gains a plain-text
`body` (H-225): SES sends it in place of the title and link, and the evidence pack code email now
has a generic subject ("Your code to open an evidence pack") with the code and guidance in the
body. Tests: `apps/api/test/letter-templates.test.ts`, `adapters.test.ts`, `evidence-link.test.ts`.
Next, part 2b: preview, sending and the letters list, with the PDF writer.

Slice 12 (the family feed, schema; migration 0061, after #71's 0060; `feat/comms-family-feed`):
`packages/db/src/schema/comms.ts`.

| Table or function | Built as |
| --- | --- |
| `family_portal_user` | Mutable. A portal account, a person and the contact the decisions name; one open link per account and contact; revoked with a reason, never reopened or deleted. A member always reads their own links; staff read and write them in the person's scope with `people.sharing.manage`. The database refuses a person assignment for a linked account, and a link for an assigned one |
| `feed_item`, `feed_item_withdrawal`, `feed_view` | Append-only, with the section 2 CHECK constraints. Staff follow the person scope; a family session (`app.family` with a member and scope `none`) sees an update only when `app.family_can_see` allows it and, once taken down, only if it saw it before (`app.family_item_shown`); it writes only its own views, for its own contacts and updates it can see. Updates are published by holders of `comms.feed.publish` and taken down by holders of `comms.feed.withdraw` in their own name where the person lives; the database stamps the times |
| `app.family_can_see` | Section 2.1, as a definer function owned by `harbour_family_reader` (a new NOLOGIN role; `pnpm db:bootstrap` before migrating), fixed search path, reading only the columns the rule needs. `packages/db/test/family-feed.test.ts` runs it and `checkFeedItemVisibility` over the same table of cases |

Slice 12 (the family feed, API part 1; `feat/comms-family-feed-api`): `apps/api/src/routes/family-feed.ts`,
contracts in `packages/contracts/src/family-feed.ts`.

| Route | Built as |
| --- | --- |
| Portal sessions | A member with an open link is resolved as a portal session (`resolveAccess(..., "portal")`): portal roles only, no grants, scope `none`, `app.family` set |
| `GET /v1/family/feed` | Portal sessions with `comms.feed.read` (MFA). Per linked person: the updates the database shows, judged again by `buildFamilyFeed` with the decisions, suspension periods, status and capacity finding read in the system's view (never returned); photos stay closed until part 1b reads their basis; one `feed_view` per entry and a `comms.feed.viewed` audit event with ids and counts; `no-store` |
| `GET`/`POST /v1/people/{id}/family-portal-links`, `.../{linkId}/revoke` | `people.sharing.manage`: only an account holding portal roles alone can be linked; `comms.portal_link.create`, `.revoke`, `.list`. The sharing decisions themselves are the people-sharing routes |
| `GET /v1/people/{id}/feed`, `POST /v1/feed-items/{id}/withdraw` | `comms.feed.publish` or `.withdraw` to list (with any withdrawal); `.withdraw` to take one down (`checkFeedWithdrawal`, once, 409 after); `comms.feed.item_withdrawn` audit and outbox event |

Next, part 1b: `POST /v1/people/{id}/feed` (compose and publish from a source record with
`composeFeedItem`, `care_note_share`, the publishing holds and the photo basis) and
`GET /v1/people/{id}/feed/exposure`. Then part 2, the web feed and staff screens.
