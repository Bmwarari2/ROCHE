# Phone medicines guides on main (slices 69 and 70)

Branch `docs/medicines-phone-guides`, from main after #188. The seven phone guides drafted on
`docs/guides-medicines-phone` (from before #188 merged) are brought over and brought up to date
with what shipped: the controlled drugs permission is checked as the dose opens; "No one is here to
witness" shows only where the home's rules allow it, and the phone says when it does not know them;
a controlled drug's conflict is decided on the web; a dose is refused where the home still records
controlled drugs on paper (H-1517). The draft banners are removed, the guides are added to the
care worker, senior carer and nurse indexes and to MOB-007, and the round guide points to the
phone's Medicines tab. The web guides on that branch were already on main and are not repeated.

## H-1518: turning controlled drug recording on and off (branch `feat/medicines-cd-recording`)

- API: `PUT /v1/locations/{id}/controlled-drugs/recording`, for the Owner or Registered Manager at
  the home (`medicines.record.manage` and `platform.location.manage`), with step-up; each step
  around the change confirmed in words; audited, refusals included. No migration.
- Web: a **Controlled drug recording** page, linked from the home's medicines reports. The round's
  notice where recording is on now points to the phone, not to a register that cannot record a
  dose; the register printout has its own notice instead of the eMAR's.
- Phone: reads the switch for the person's home (kept on the phone; never read counts as off) and
  stops a controlled drug before signing where it is not on; a 403 for a missing permission on a
  refused copy is now read as refused, so it never holds later copies; tests for the 409 path.
- Docs: hazard log HZ-115, the Registered Manager guide, the phone guide, medicines.md section 14.3,
  MEDS-005, H-1529 (CSO, provisional).
