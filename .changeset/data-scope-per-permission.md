---
"@harbour/api": patch
"@harbour/domain": patch
"@harbour/db": patch
"@harbour/sync": patch
---

Security fix: each permission now reaches only the people that the roles and grants giving it
reach. Before, a member of staff with two roles (for example a care worker at one home who also
views finance across the organisation) could open and add to care records at every home, and the
people anyone was assigned to, or had opened by break-glass, counted for everything they held.
Now the people you are assigned to count only for what your care worker role gives you, and
break-glass opens a record for reading only. The audit trail is shown whole only to those who
hold it across the organisation.

Clinical safety changes

- Some staff will see fewer people. Before go-live, the Registered Manager reviews role bundles
  with the pre-deployment access report (docs/runbooks/data-scope-per-permission-access-report.md),
  which lists everyone whose reach narrows. Cover at another home is a role assignment at that
  home, until grants can be managed in the product.
- Care coordinators: the people and their care plans at their home now sync to the phone, as
  they did not before; recent notes and charts do not, because the role does not read care notes.
  Add that permission to the coordinator's role if they need them offline.
- Administrators, and any role that cannot open people's records, see in the task list only the
  tasks given to them that are about no one.
- A task about a person can be given only to someone who can open that person's record and do
  the task, and escalations and their fallbacks skip anyone who cannot.
- Sync every device before deploying: each phone in Care mode should be on the network with
  nothing waiting, so nothing written under the old reach is left on a phone that can no longer
  send it.
