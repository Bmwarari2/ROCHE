# How to import medicines, care plans or staff file checks

When you move to Thapsus Care, you can bring people's medicines, their care plans and the checks on
your staff files across from your old system, from a CSV file (a spreadsheet saved as plain text).
Nothing is used until a person has checked it: medicines arrive not yet checked, care plans arrive
as drafts and staff file checks arrive not verified.

**Who can do this**: the owner. Another role can do it only if your organisation gives it the import
wizard across the whole organisation, with the right to add and see people and the right to manage
what it imports: medicines records, care plans or staff files. Adding the records needs you to
confirm it is you with your passkey or authenticator app.

**Register row**: PLAT-014.

## Before you start

- The people must already be in Thapsus Care, each with their NHS number. Medicines and care plans
  are matched to a person by NHS number only, never by name. To bring people across first, see
  [How to import people from another system](import-people-from-another-system.md).
- Staff file checks are matched to a staff file by the member of staff's work email only. Each
  member needs a staff file in Thapsus Care first.

## Steps

### Upload the file

1. Save the file from your old system as CSV, with one header row. Dates are dd/mm/yyyy.
2. Go to **Import records** in the menu.
3. Under **Upload a file**, choose **What the file holds**: **Medicines**, **Care plans** or
   **Staff file checks**. Each has its own columns. If you change it after choosing a file, the page
   says the columns were matched again: check each one.
4. Choose the **Home**. Each row stays with its own person or staff file; the home sets how long
   you can undo the import.
5. Choose the **CSV file**: a .csv file with one header row, up to 5,000 rows.
6. Under **Match the columns**, check each column. Choose the right field, or **Leave this column
   out**. Fields marked "(needed)" must each have a column.
7. Choose **Upload for checking**. The import opens and says "File uploaded. Check it before adding
   anything."

### Check the file

1. Under **Check the file**, choose **Check the file**. Nothing is added by checking.
2. Read **What the check found**. It says how many rows are ready and how many have errors.
3. Read what adding does, for example **What adding the medicines does**.
4. Under **What happens to each row**, a row that cannot be added says, for example, "Row 4: will
   not be added. Correct it in the file." The errors are listed by row and field.
5. If there are errors, correct every one in your old file, choose **Discard this file**, then
   **Discard file**, and upload it again.

### Add the records

1. If Thapsus Care says phones are in use in this organisation, read the warning and tick **I accept
   that this import cannot be undone**.
2. Choose **Add**, for example **Add 12 medicines**. Confirm it is you if asked, then come back to
   the page and check the file again.
3. The page says what was added, for example "Medicines added, not yet checked. Have them checked
   before each person's next round."

## Important

- **Imported medicines are "Imported, not yet checked" until a second person checks them.** No
  dose can be given from them until a second person competent in medicines has checked each one
  against its source document, whatever your organisation's policy for other medicines (HZ-005).
  Each person gets an urgent task to have their medicines checked before their next round. See
  [How to second-check a medicine](../nurse/second-check-a-medicine.md).
- **A typed name never becomes a medicine.** Each medicine is the product its code names in the
  NHS medicines list (dm+d, the Dictionary of medicines and devices), with dm+d's own name, route
  and dose unit. Thapsus Care checks the codes and the medicines rules, but never decides a dose:
  the person who checks it compares it with the source.
- A regular medicine imported from a file is given at the same times every day. Any other pattern
  is added by hand.
- **Care plans arrive as drafts.** Nothing is published. Someone reviews each draft, adds the
  actions and sign-off, and publishes it, as in
  [How to write and publish a care plan](../nurse/write-and-publish-a-care-plan.md). A person who
  already has a draft care plan is refused.
- **Staff file checks arrive not verified.** A check counts only once someone who has seen the
  evidence verifies it on the staff file, as in
  [How to record a pre-employment check](../hr-lead/record-a-pre-employment-check.md). A check
  the file already holds, and a check on your own staff file, are refused. Health, employment
  history, conduct and the contents of a DBS (Disclosure and Barring Service) certificate are
  never imported.
- **All or nothing.** Nothing is added until every row can be added, and then the whole file is
  added at once.
- An import never changes or overwrites a record already in Thapsus Care. A row whose person or
  staff file Thapsus Care does not hold is refused.
- The uploaded rows are deleted at the time shown under **Where it stands**, unless they are added
  first. You can upload again.
- What was imported is recorded, with who did it and when.
- To take an import back, see [How to undo an import](undo-an-import.md). Medicines are withdrawn
  rather than deleted, and undo is refused once any of them has been checked or changed.
- The rules are in the
  [platform specification](../../specs/platform.md#importing-medicines-care-plans-and-staff-files-slice-51)
  and the hazard log,
  [HZ-130](../../clinical-safety/hazard-log.md#hz-130-imported-records-mis-mapped-duplicated-or-attached-to-the-wrong-person).
