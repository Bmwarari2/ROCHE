# How to undo an import

If you added people from the wrong file, or to the wrong home, you can undo the import once, soon
after adding them. Undo removes only the people that import added.

**Who can do this**: the owner, or anyone your organisation has given the import wizard across the
whole organisation. Undoing needs you to confirm it is you with your passkey or authenticator app
(step-up).

**Register row**: PLAT-014.

## Steps

1. Go to **Import people** in the menu, and open the import under **Imports**.
2. Read **Where it stands**. While undo is available it says until when, for example "This import
   can be undone until 07/11/2026 14:20, or until a phone may have received the people, whichever
   comes first."
3. Choose **Undo this import**, and read **Undo this import?**.
4. Choose **Remove**, for example **Remove 24 people**. Confirm it is you if asked, then come back
   and try again.
5. The import says "Import undone. The people it added have been removed."

## Good to know

- **Undo is possible only once, and only while nothing has happened to those people.** Harbour
  refuses it after the time shown, once a phone may have received the people, once any of them has
  been changed, or once anything has been recorded about them, such as a note, a task someone acted
  on or a document.
- If phones are in use in your organisation, treat every import as one that cannot be undone.
  Harbour asks you to accept this before you add the people.
- When undo is not available, the page says "This import can no longer be undone. Correct any
  record imported by mistake on the person's record." A person imported by mistake cannot be
  removed after that; ask Harbour support.
- Undo also removes the allergy status checks the import raised that are still open.
- The audit trail keeps the record of what was imported and undone.
- The rules are in the
  [platform specification](../../specs/platform.md#import-wizard-schema-and-api-slice-26-adr-0092)
  (rule 24), [ADR-0092](../../decisions/0092-import-wizard.md) and
  [HZ-130](../../clinical-safety/hazard-log.md#hz-130-imported-records-mis-mapped-duplicated-or-attached-to-the-wrong-person).
