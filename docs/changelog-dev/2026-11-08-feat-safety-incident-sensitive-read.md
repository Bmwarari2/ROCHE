# A narrower permission for a death record's sensitive detail (HZ-011, HZ-013)

Branch `feat/safety-incident-sensitive-read`, from `main`. Item 4 of the lead's list of gaps the
slice 83 guides review found.

## What changed

- **Permission**: `safety.death_detail.read` (care record, so MFA applies): the death record (the
  clinician's judgement on whether the death may be unnatural or suspicious, its steps with police
  references, the mortality review) and police references on a missing person episode. Built-in
  holders: owner, Registered Manager, deputy, clinical lead, team leader, quality lead. Not agency
  workers, care coordinators or care workers, who keep `safety.incident.read`.
- **Row-level security** (migration 0159, written as 0159 until it is renumbered before merge):
  restrictive read policies on `death_record` and `death_step` (the worker and the migrator still
  read them); existing tenants' built-in roles gain the permission, audited.
- **API**: the death record list and record need the permission; an episode's police references
  are hidden from readers without it, with `policeReferenceHidden` saying one exists.
- **Web**: the deaths screens and their menu item follow the permission; an episode says a police
  reference is recorded and who sees it.
- **Docs**: safety.md, records of processing, data standards, HZ-011 and HZ-013, human actions
  H-1578 to H-1580.
