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
  restrictive read policies on `death_record`, `death_step` and a death record's earlier versions
  in `record_version` (the worker and the migrator still read them); existing tenants' built-in
  roles, and roles cloned from them, gain the permission, audited.
- **API**: the death record list and record need the permission; an episode's police references
  stay visible to the search while the person is missing or just found, and once the episode is
  closed are hidden from readers without it (`policeReferenceHidden`); `policeCalled` says the
  call was made whoever may see the reference, on the episode and the list (HZ-127; clinical
  review B1, H1). Writing to a death record needs the permission as well as
  `safety.incident.manage` (403, not 404); reading or releasing a disclosure item from a death
  record needs it too; the judgement's audit event names the fields, never the answers.
- **Web**: the deaths screens and their menu item follow the permission; an episode says a police
  reference is recorded and who sees it.
- **Docs**: safety.md, records of processing, data standards, HZ-011, HZ-013 and HZ-127, human
  actions H-1578 to H-1580.
