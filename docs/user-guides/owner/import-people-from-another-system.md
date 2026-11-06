# How to import people from another system

When you move to Harbour, you can bring the people you support across from your old system, a home
at a time, from a CSV file. Nobody is added until you have checked the file and confirmed it.

**Who can do this**: the owner. Another role can do it only if your organisation gives it the
import wizard, and the right to add and see people, across the whole organisation; someone whose
role covers some homes only is refused. Adding the people needs you to confirm it is you with your
passkey or authenticator app (step-up).

**Register row**: PLAT-014.

## Steps

### Upload the file

1. Save the file from your old system as CSV, with one header row. Dates are dd/mm/yyyy.
2. Go to **Import people** in the menu.
3. Under **Upload a file**, choose the **Home**. Everyone in the file is added at this home.
4. Choose the **CSV file**: a .csv file with one header row, up to 5,000 people.
5. Under **Match the columns**, check each column. Harbour matches a column to the field with the
   same name where there is one. Choose the right field, or **Leave this column out**. Fields
   marked "(needed)" must each have a column. Columns you leave out are not uploaded.
6. Choose **Upload for checking**. The import opens and says "File uploaded. Check it before
   adding anyone."

### Check the file

1. Under **Check the file**, choose **Check the file**. Nothing is added by checking.
2. Read **What the check found**, then **What adding the people does**.
3. If there are errors, they are listed by row and field. Correct every one in your old file,
   choose **Discard this file**, then **Discard file**, and upload it again.
4. If there are possible duplicates, choose **Open the record already in Harbour to compare** where
   it is shown, or compare the two rows. When you have checked each one, tick it ("... I have
   checked it").
5. Read **Allergy status**.

### Add the people

1. If Harbour says phones are in use in this organisation, read the warning and tick **I accept
   that this import cannot be undone**.
2. Choose **Add**, for example **Add 24 people**. Confirm it is you if asked, then come back to the
   page and check the file again.
3. Under **People added**, read the allergy statuses to check, and choose **Open your tasks**.

## Good to know

- **An import never changes, merges with or overwrites anyone already in Harbour.** A row with an
  NHS number or local identifier already on a record is an error, and changes to an existing person
  are made on their record. Possible duplicates must each be checked and ticked before anyone is
  added.
- **All or nothing.** People are added only when every row is valid, and the whole file is added
  at once.
- **Allergy status is never imported.** Every person's allergy status is "not recorded" until
  staff check it on their record, whatever the file says. Each person whose file stated a status
  gets a task.
- Imported people have no photo, room or placement until staff add them.
- The uploaded rows are deleted at the time shown under **Where it stands**, unless the people are
  added first. You can upload again.
- You cannot import while sample data is in place. Remove it first from
  [getting started](work-through-getting-started.md).
- Only people can be imported for now, from a CSV file. Contacts, allergies and staff are still to
  come.
- To take an import back, see [How to undo an import](undo-an-import.md).
- The rules are in the
  [platform specification](../../specs/platform.md#import-wizard-schema-and-api-slice-26-adr-0092),
  [ADR-0092](../../decisions/0092-import-wizard.md), the
  [data standards](../../specs/data-standards.md) and the hazard log,
  [HZ-130](../../clinical-safety/hazard-log.md#hz-130-imported-records-mis-mapped-duplicated-or-attached-to-the-wrong-person)
  and [HZ-007](../../clinical-safety/hazard-log.md#hz-007-incorrect-or-missing-allergy-display).
