# Harbour voice and tone

How Harbour writes. It applies to every word in the product: buttons, labels, errors, empty
states, notifications, emails, help text and the default copy in `@harbour/ui` components. It
follows master prompt section 8 (content and tone) and section 5.4 (accessibility and language).

People who read Harbour are care workers at the end of a long shift, registered managers under
inspection, finance staff, and the families and residents themselves. Write so that each of them
understands the first time, on a phone, with one hand.

## The rules

1. **Sentence case everywhere.** Capitalise the first word and proper nouns only: "Add care note",
   "Medicines due", "Rowan House". Never Title Case, never ALL CAPS, including buttons, headings,
   menu items and table headers.
2. **Plain English.** Use the shortest common word. On family and resident surfaces (the family
   portal, resident-facing screens, letters to families) write for a **reading age of 9**: short
   sentences (aim for 15 words or fewer), one idea per sentence, no jargon or abbreviations.
   Staff surfaces may use the care terms staff use every day (MAR chart, PRN, NEWS2), but still
   prefer plain words.
3. **Never blame the person.** Errors describe what happened and what to do next. They never say
   "you failed", "invalid", "illegal", "wrong" or "error".
4. **Destructive actions say what will happen, and offer undo where the law allows.** The button
   names the action and the thing ("Remove shift", not "OK"). Where the action can be reversed
   lawfully, show an Undo action afterwards. Care records are never deleted: they are corrected,
   and the original stays visible with a line through it (section 5.5).
5. **British English.** Organisation, colour, licence (noun), license (verb), centre, programme,
   catalogue, recognise, practise (verb), practice (noun), judgement, enrol, cheque, travelling,
   aluminium, paediatric, haemoglobin, oedema. Code identifiers follow their library (`color`,
   `center`).
6. **UK dates and times.** Dates are dd/mm/yyyy (`03/10/2026`), or "3 October 2026" in letters.
   Times use the 24-hour clock (`14:05`, `08:00`), never am/pm. Show UK local time and say
   so when it matters (around clock changes). Machine values stay ISO 8601 in a `<time>` element.
7. **No emoji**, anywhere: not in copy, notifications, emails or commit messages. Icons are Lucide
   and always sit beside a word.
8. **Status is a word, not a colour.** Every status has an icon and a word: Overdue, Due, Done,
   Not applicable. Never rely on colour, position or an icon alone.

## Voice

Calm, clear, kind and direct. Harbour sounds like an experienced senior carer: it knows the
job, it does not panic, and it never talks down to anyone.

| We are | We are not |
| --- | --- |
| Calm: "Your changes have not been sent yet" | Alarmist: "SYNC FAILURE!" |
| Direct: "Enter a date of birth" | Vague: "Please check your input" |
| Respectful: "Ada prefers to be called Ada" | Clinical or cold: "Service user 0042" |
| Human: "Nothing to review" | Cute: "Woohoo, all done!" |

Tone shifts with the moment. Routine confirmations are brief ("Saved"). Clinical safety messages
(stale data, missed medicines, sync failures) are plain and specific, and never softened into
something that could be ignored.

## Writing about people

- Use the person's name, and their preferred name where recorded: "Ada", not "the resident".
- Say "person", "resident" (care homes) or "the person we support" (home care). On staff screens
  "service user" is acceptable where the regulation uses it; never on family surfaces.
- Describe the need, not the label: "uses a wheelchair", not "wheelchair-bound".
- Respect the Accessible Information Standard: when a person has communication needs, the screen
  says so in words ("Needs large print"), not with a coloured flag alone.

## Patterns

### Buttons and links

- Start with a verb and name the thing: "Add care note", "Record medicines", "Print record".
- Primary buttons: one per screen or sheet. Secondary: alternatives such as "Cancel" or
  "Save as draft".
- Tertiary links end with a chevron, which the component adds: "View all care notes ›",
  "Learn more ›". Never "Click here" or "Read more" on its own; the link text must make sense
  out of context.
- Avoid "Yes" and "No" in confirmations. Repeat the action: "Remove shift" and "Keep shift".

### Errors and validation

Say what to do, in the person's terms. Put the message next to the field it is about.

| Do | Do not |
| --- | --- |
| Enter a date of birth | Date of birth is required |
| Enter the date as dd/mm/yyyy, for example 02/04/1938 | Invalid date format |
| Enter all 10 digits of the NHS number | NHS number invalid |
| This could not be sent. Your answers are still here, so you can try again. | Submission failed |
| Harbour could not reach the server. Your changes are safe on this device. | Network error 503 |

When something is our fault, say so and say what happens next. Never show stack traces, codes
without words, or internal names.

Fields with a maximum length show a count under the field: "You have 20 characters remaining",
then "You have 3 characters too many" once over. Never cut the text off; say what to do when the
form is sent: "Shorten the reason to 1,000 characters or fewer."

### Destructive actions

Name what will happen, to what, and whether it can be undone.

- Title: "Remove Ben Sample from the night shift on 14/10/2026?"
- Body: "Ben will be told by email. You can add him again later."
- Buttons: "Remove from shift" (destructive) and "Keep on shift" (secondary).
- Afterwards, a toast with Undo where the change can lawfully be reversed:
  "Shift removed from the rota" with "Undo".

Where the law requires a record to stay (care notes, medicines administration, incidents,
anything under a retention schedule or legal hold), there is no delete. Offer "Correct this note"
instead, and explain: "Notes cannot be deleted. Your correction is added and the original stays
visible."

### Corrections

The electronic single-line correction: the original text stays, struck through, followed by the
correction, who made it and when ("Corrected by Ben Sample on 03/10/2026 11:12") and, where
given, the reason ("Reason: Wrong number of carers recorded").

### Autosave and sync

Short and factual. Autosave status uses exactly these words: "Saving", "Saved",
"Not saved, retrying". Offline and sync banners:

- Offline: "You are offline. You can keep working. Your changes are kept on this device and sent
  when you are back online."
- Syncing: "Sending your changes."
- Sync failed: "Your changes have not been sent yet. Harbour could not reach the server. Your
  changes are safe on this device." with "Try again".
- Stale data: "This information may be out of date. Check when it was last updated before you act
  on it." with the time it was last updated.

### Empty states

Say what is empty and what to do next: "No care notes yet. Notes written by the team about Ada
will appear here." with "Write the first note". Never "No data" or "Nothing found!".

### Notifications and toasts

One short sentence in the past tense for what happened ("Care note saved"), with detail
underneath if useful ("Ada Example, 03/10/2026 14:05"). Toasts never carry information that is
needed later; anything important also appears on the page.

## Numbers, units and formats

- Numbers: numerals for 10 and over and for all measurements, doses and times ("2 tablets",
  "5 mg"); words for one to nine in running text where no unit follows ("three visits").
- Units: a space between number and unit ("5 mg", "37.5 °C", "120 ml"). Write "micrograms" in
  full, never "mcg" or "µg", to avoid dosing errors.
- Money: "£1,250.00"; no pence on whole pounds in headlines ("£1,250").
- Phone numbers: "01632 960 001"; NHS numbers in 3-3-4 groups: "999 000 0018".
- Ranges: "08:00 to 10:00", "Monday to Friday" in sentences; an en dash only in tables.
- Percentages: "75%".

## Punctuation and grammar

- No full stops in headings, buttons, labels, table headers or single-sentence toasts. Full stops
  in body text and in descriptions of two or more sentences.
- Contractions are fine on staff screens if they read naturally; on family and resident surfaces
  prefer the full form ("you are", "do not"), which is easier for many readers and translators.
- Avoid "please" in instructions; it adds length without meaning. Do say "sorry" when Harbour
  has let someone down.
- Use "and", not "&", and avoid "e.g.", "i.e." and "etc." ("for example", "that is", or a list).
- Abbreviations: spell out on first use on family surfaces ("Care Quality Commission (CQC)").

## Language and translation

- Every string goes through i18n (ICU message format). Default copy in `@harbour/ui` components
  is the English fallback; apps pass translated strings through the component props.
- Never build sentences by joining fragments; give translators whole sentences with
  placeholders.
- Welsh: keep strings short and avoid idioms so Welsh translations fit. Honour the Welsh Active
  Offer flag for Welsh tenants.

## Checklist before shipping copy

- Sentence case, British spelling, no emoji.
- Dates dd/mm/yyyy, times 24-hour.
- Errors say what to do and do not blame.
- Destructive actions name the outcome; Undo offered where lawful.
- Status has an icon and a word.
- Family and resident surfaces read at age 9 (short sentences, everyday words).
- Link and button text makes sense on its own.
