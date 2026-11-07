# Controlled drug recording not turned on (H-1517)

Branch `fix/meds-cd-not-turned-on`, from `main`. A finding of the medicines guides (PR #185): the
round's controlled drugs notice told staff to record in Harbour's register, which no home uses yet.

- New per-location flag `medicines.cd_recording`, off by default: controlled drugs are recorded in
  Harbour's register at a home only once both the web and the phone record them there (H-1517).
- `GET /v1/me/locations/{id}/flags`: the flags as they apply at a location the member works at.
- The controlled drugs tab and every register page show "Controlled drug recording is not turned on
  for this home" at the top, saying the paper register is the record, until the flag is on there.
- The round's record page tells staff to record a controlled drug in the paper register while the
  flag is off, and in the person's controlled drugs register once it is on.
- While it is off the web offers none of the register's forms, and the printed page and the
  person's stock say the paper register is the record (clinical review). The demo seed releases
  recording at the demo home, so the journeys still record.
- Hazard log: HZ-115 (partly built, CSO decision pending) and HZ-008 controls and tests. The API does not yet refuse register entries
  where the flag is off (an open control under HZ-115, for the phone release, H-1518).
