# User guides: medicines on the phone (Phase 2 slice 81)

Branch `docs/guides-medicines-phone`, merged with `main` at d4c81025 (after #188, the phone
medicines release, slices 69 and 70, and #193).

## What changed

- **Seven phone guides**, checked step by step against `apps/mobile` and the API on `main`: giving
  medicines, scanning a pack and correcting a record (care worker); setting a medicines PIN and
  witnessing a controlled drug (care worker, for every role that witnesses); giving a controlled
  drug and reviewing doses recorded twice (nurse). Every bold label is in the mobile catalogue
  (`packages/i18n/src/messages/mobile.en-GB.json`); quoted words are the round's status words, the
  sync banner's and the API's.
- The draft notes and branch names are gone. The guides now say: check the sync banner before
  relying on the round (HZ-002); the when-required interval, 24-hour maximum and "last dose not on
  this phone" stops as the phone shows them, and that the phone counts only the records it holds
  (HZ-004, HZ-028); the allergies shown beside the medicine, with the phone never deciding (HZ-007);
  a dose given offline is not on Thapsus Care until the phone sends it, and a refused dose gets an
  urgent review (HZ-006).
- **Controlled drugs**: the paper register notice at the top (H-1517); who may witness (holders of
  witness permission with current competence, a care worker only for the people assigned to them,
  never an agency or bank worker, never the giver); when a witness is needed (always at a care home
  or where the phone does not know the home's services; "no one is here to witness" only where the
  home runs only home care, supported living, live-in, complex care or day services); the stop for
  someone who may not record controlled drugs; and that a controlled drug's conflict is decided on
  the web with step-up by someone who had no part in the dose.
- **Corrections**: only your own records, unless you manage the medicines record (nurses, deputy
  managers, Registered Managers and owners).
- `care-worker/run-a-round.md` is unchanged: medicines are on the phone's Medicines tab, not on
  its round.
- The role indexes (care worker, senior carer, nurse, Registered Manager), the guides README and
  the register's user docs column (MEDS-002, MEDS-003, MEDS-005, MOB-007) link the seven guides.
  MEDS-002's user docs cell lost a stray leading comma.

## No screen yet, so the guides say so

- The web has no screen to decide a dose recorded twice or to correct a dose record, though the
  phone sends staff there for controlled drug conflicts, a wrong first record and controlled drug
  corrections. The guides say the web screen is not there yet and to tell the nurse in charge or the
  Registered Manager.
- Still not on the phone: wristband scans, doses taken by the person or given by family, a witness
  for other medicines, an early dose with a reason, controlled drug corrections and stock counts.

## Found, not fixed here (for the builders and the CSO)

- The phone does not know whether controlled drug recording is turned on at the home (H-1517): it
  lets a controlled drug be given and signed, and the API refuses it on upload, after the dose.
- The phone offers **Correct** on other people's records to staff who may correct only their own;
  the API refuses the correction on upload.
- The phone does not check the amount typed against what is left of a when-required medicine's
  24-hour maximum, or the giver's medicines competence (HZ-119 lists the offline competence gate as
  planned); both are refused only on upload, after the dose.
- HZ-004's conflict control says the nurse in charge reviews conflicts "on the web", which has no
  such screen yet.
