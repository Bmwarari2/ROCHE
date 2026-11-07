# How to give medicines on the phone

> Arrives with the phone release from `feat/mobile-meds-cd-offline` (slices 69 and 70); not on main yet.

The medicines round on the phone lists the doses due, time slot by time slot, and records each
one, with or without a connection.

**Who can do this**: care workers, senior carers, nurses and managers who give medicines, within
their medicines competence. A care worker sees only the people assigned to them. The
**Medicines** tab shows only for staff who give medicines.

**Register rows**: MOB-007, MEDS-002, MEDS-003.

## Steps

1. Go to the **Medicines** tab. The round shows each time slot, for example "07/11/2026 at 08:00",
   with doses still outstanding from yesterday first.
2. Check each dose's status word: "Not due yet", "Due now", "Late: no outcome recorded" or
   "Outcome recorded". A dose marked **Time-critical** must be given on time.
3. Choose a dose to open **Medicines for this person**. Check the header: photo, name, date of
   birth and allergies.
4. Under **Doses due** or **When required**, choose the medicine.
   - A when-required medicine shows when it was last given, how many have been given in the last
     24 hours and "Not before" a time when it is too soon.
5. Under **What happened**, choose **Given**, **Refused**, **Not given**, **Not available** or
   **Withheld**.
   - For anything but **Given**, choose the **Reason**. For **Other** or **Withheld**, also fill
     in **What happened, in words**.
6. For **Given**, do the checks under **Before you give it**:
   - Look at the photo, name and date of birth, then tick **I have checked their photo, name and
     date of birth**.
   - Choose **Scan the pack** and scan the barcode (see
     [How to scan a medicine pack on the phone](scan-a-medicine-pack-on-the-phone.md)).
   - Check **Amount given**.
7. Give the medicine, then choose **Record dose**. The phone says "Recorded on this phone. It
   will be sent when there is a connection."
8. To leave without saving, choose **Stop without recording**. Nothing you chose is saved.

If something stops the record, the phone says what in words above **Record dose**, for example
"Too soon after the last dose. Do not give it now: the nurse in charge decides." Nothing is saved
until it is put right.

## Important

- **Offline**: the dose is kept on the phone at once and sent at the next connection. Until then
  it is only on this phone: the office, the web and other phones do not see it, and the record
  says "Recorded on this phone, not sent yet". Do not switch off or reset the phone with records
  waiting (HZ-004, HZ-006).
- **If Thapsus Care does not take a dose** when it is sent, it leaves the round and moves to
  **Not saved: needs attention** at the top of the screen. Tell the nurse in charge straight away;
  the dose may already have been given (HZ-006).
- **When the round will not open**, the phone says why instead of showing doses: it has not
  finished syncing at least once, it has not read your organisation's dose windows, or its safety
  checks could not run. Connect to the internet and wait; if it stays, tell your manager
  (HZ-004).
- **A rooted or jailbroken phone cannot record medicines.** The phone says so and medicines stay
  switched off. Use another phone and tell your manager.
- **The phone does not decide.** It shows what was prescribed and applies your organisation's
  dose windows. It never chooses a dose, says whether a medicine is safe, or suggests what to do.
  When it is too soon, or the last dose may be older than the records on the phone ("The last dose
  may be older than the records on this phone"), it will not record the dose: ask the nurse in
  charge, who decides on the web (HZ-004, HZ-028).
- **Not recorded is not none.** "Allergies not recorded" or "Allergies are recorded but are not on
  this phone yet" means check with the nurse in charge before giving any medicine (HZ-007).
- If the round lists medicines the phone could not read, they are not on the round on this phone.
  Use Thapsus Care on the web and tell the nurse in charge (HZ-003).
- A time-critical dose sends a reminder on the phone when its window opens: "A time-critical
  medicine is due now. Open the medicines round." It names no one and no medicine. The round, not
  the reminder, says what is due (HZ-003).
- Controlled drugs need a witness: see
  [How to give a controlled drug on the phone](../nurse/give-a-controlled-drug-on-the-phone.md).
- Still to come: wristband scans (photo confirmation only for now), taken by the person
  themselves or given by family, witnessed doses that are not controlled drugs, and giving a dose
  inside the interval with a reason. These are on the web.
