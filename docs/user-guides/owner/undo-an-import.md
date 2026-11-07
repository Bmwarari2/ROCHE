# How to undo an import

If you added people from the wrong file, or to the wrong home, you can undo the import once, soon
after adding them. Undo removes only the people that import added. Medicines, care plans and staff
file checks can be undone too: see
[Undo an import of medicines, care plans or staff file checks](#undo-an-import-of-medicines-care-plans-or-staff-file-checks).

**Who can do this**: the owner, or anyone in a role your organisation lets import records for the
whole organisation. Undoing needs you to confirm it is you with your passkey or authenticator app.

**Register row**: PLAT-014.

## Steps

1. Go to **Import records** in the menu, and open the import under **Imports**.
2. Read **Where it stands**. While undo is available it says until when, for example "This import
   can be undone until 07/11/2026 14:20, or until a phone may have received the people, whichever
   comes first."
3. Choose **Undo this import**, and read **Undo this import?**.
4. Choose **Remove**, for example **Remove 24 people**. Confirm it is you if asked, then come back
   and try again.
5. The import says "Import undone. The records it added have been removed or withdrawn."

## If a person was imported by mistake

1. Open the import and read **Where it stands**. If it can still be undone, undo the whole import
   (the steps above) and import the right file. Undo is the only way to remove people.
2. If it can no longer be undone and the person is real but some details are wrong, correct them on
   the person's **Personal details** tab. The history keeps what the import said.
3. If the person should not be in Thapsus Care at all (the wrong person, or someone already on another
   record), tell your Registered Manager straight away. Thapsus Care has no "created in error" status
   for a person yet, so the record stays on the list of people receiving care, and staff could
   choose it by mistake. Until your clinical safety officer decides what to do:
   - make sure staff at that home know, for example at handover, that the record is a mistake
     and must not be used, and that anything for the real person goes on the real record;
   - record nothing more on the mistaken record. Its allergy status check from the import stays
     open: leave it, and tell your Registered Manager it is there;
   - never record a death, and do not record a discharge or transfer unless your Registered
     Manager and clinical safety officer decide to. Those can send notifications to other people;
   - if the person should never have been in Thapsus Care, tell your data protection lead, who decides
     whether it is a personal data breach;
   - ask Thapsus Care support.

## Undo an import of medicines, care plans or staff file checks

Open the import and follow the same steps. While undo is available:

- imported medicines are withdrawn, not deleted: the person's medicines page still shows each one,
  marked "Withdrawn: the import that added it was undone". Undo is refused once any of them has
  been checked or changed;
- imported draft care plans are removed, only while every one is unchanged and unpublished;
- imported staff file checks are removed, only while none has been verified or changed.

The undo box and its button speak of "people" for every kind of import. For a medicines, care plan
or staff file import, it is the medicines, plans or checks that are taken back.

## Good to know

- **Undo is possible only once, and only while nothing has happened to those people.** Thapsus Care
  refuses it after the time shown, once a phone may have received the people, once any of them has
  been changed, or once anything has been recorded about them, such as a note, a task someone acted
  on or a document.
- If phones are in use in your organisation, treat every import as one that cannot be undone.
  Thapsus Care asks you to accept this before you add the people.
- When undo is not available, the page says "This import can no longer be undone. Correct any
  record imported by mistake on the person's record." See
  [If a person was imported by mistake](#if-a-person-was-imported-by-mistake).
- Undo also removes the allergy status checks the import raised that are still open.
- What was imported and undone is recorded, with who did it and when.
- The rules are in the
  [platform specification](../../specs/platform.md#import-wizard-schema-and-api-slice-26-adr-0092),
  [ADR-0092](../../decisions/0092-import-wizard.md) and
  [HZ-130](../../clinical-safety/hazard-log.md#hz-130-imported-records-mis-mapped-duplicated-or-attached-to-the-wrong-person).
