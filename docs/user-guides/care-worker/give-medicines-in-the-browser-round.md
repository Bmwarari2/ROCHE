# How to give medicines in the browser round

The medicines round on the web, for the office computer or a tablet's browser, lists the doses
due at your home and records each one on its own page, with the person and their allergies beside
the medicine.

**Who can do this**: care workers, senior carers, nurses and managers who give medicines, and
agency or bank workers. A care worker or agency worker sees only the people assigned to them. The
API checks your medicines competence each time you record a dose.

**Register rows**: MEDS-002, MEDS-004.

## Steps

1. Go to **Medicines round** in the menu. If Thapsus Care asks, choose your home.
2. The page lists everyone at the home with medicines due, room by room. It shows doses due from
   two hours ago to two hours ahead, and any earlier dose still not recorded. Late doses come
   first, then doses due now, then the rest, with time-critical doses first in each group.
3. Choose **Open Ada's round** (with the person's name) to go to one person. You can also open the
   person's record, choose **Medicines** and then **Open the medicines round**.
4. Check the top of the page: the person's photo, name, date of birth, NHS number and allergies.
   Check **Worked out at** and reload the page if it has been open a while.
5. Under **Doses**, find the dose. Each shows its state as a word, **Due** and the time, and
   **Time-critical** where it applies. Beside the medicine you may see the
   **Covert administration record** or **Self-administration** level.
6. Choose **Record** for the dose, for example **Record Examplomol 500 mg tablets due
   07/11/2026 08:00**. It is offered only for a dose that is late or due.
7. On **Record a dose**, read the medicine, the dose, the route, **For:** and **Special
   instructions:**. Compare the medicine with the allergies listed above the form yourself.
8. Under **What happened**, choose **Given**, **Refused**, **Not given**, **Withheld**, **Not
   available**, **Taken by the person themselves** or **Given by family, as agreed**.
   - For anything but given, choose the **Reason**. For **Other**, fill in **Say why**.
   - For a dose taken, check **Amount given**. It shows the prescribed amount when the
     prescription gives one amount. Change it only to what was actually given.
   - Tick **Given covertly, under the covert administration record** only when it was given in
     the way the covert record says.
9. Fill in **Why it was given early or late (if it was)** or **Why the amount differs from the
   prescription (if it does)** only if it applies. If the API needs one, it asks.
10. Choose **Record the dose**. The person's round opens and says **Dose recorded**.

## What the words mean

| You see | It means |
| --- | --- |
| Not due yet | The dose's window has not opened. |
| Due now | Give it now. |
| Late: no outcome recorded | The time has passed and nothing is recorded. It stays late until an outcome is recorded. |
| Outcome recorded | Done. It cannot be recorded again. |
| Recorded twice on different devices: waiting for review | Two devices recorded the same dose. The nurse in charge reviews it. Do not give it again. |
| Not yet checked | The medicine has not had its second check. Your organisation decides whether it may be given; read the notice under it. |
| Imported, not yet checked | Copied in from another system. Do not give it until a second person has checked it: **Given** is not offered. |
| Check found a difference | Do not give it. Tell the nurse in charge. |

## Important

- **Thapsus Care never decides a dose, an interaction or an allergy match.** It shows the medicine
  and the allergies side by side, and you compare them (HZ-007).
- **"Allergies not recorded" is not "No known allergies".** Nobody has recorded whether the
  person has allergies. Check with the nurse in charge before giving any medicine (HZ-007).
- If people's names, photos and allergies cannot be read, the round lists no doses and says so.
  Open each person's round instead, or try again (HZ-001).
- **When nothing is recorded**: when a dose's window ends with no outcome, Thapsus Care raises a
  task for the nurse in charge, urgent for a time-critical dose. The task stays open, and goes
  into the handover, until an outcome is recorded. A missed dose never becomes due again by
  itself (HZ-003).
- Recording a dose also raises a task for the nurse in charge when it is over the 24-hour
  maximum, when there is no checked dosing record to compare a variable dose with, or when the
  record needs a review.
- **Covert doses**: if the medicine has no current covert administration record, the hint says
  so. Tick **Given covertly** only if it really was given covertly: the dose is flagged and the
  nurse in charge is told (HZ-026). If the covert records cannot be read, check the paper record
  before giving a medicine covertly.
- **Clock changes**: on the day the clocks go forward, a skipped time is due an hour later. On the
  day they go back, a repeated time is given once, at the first (HZ-009).
- A dose that is not on the round any more, already recorded, not yet due or waiting for review
  shows no form. Go back to the round and choose it again (HZ-004).
- **Controlled drugs cannot be recorded here yet.** Record a controlled drug in the controlled
  drugs register and on the paper MAR, with a witness, and tell the nurse in charge.
- If your medicines competence is not current, the dose is refused unless a manager has approved
  an override (HZ-119).
- Corrections and recording a dose given earlier are not on the web yet.
- The round on the web does not work offline. For offline rounds, use the phone.
