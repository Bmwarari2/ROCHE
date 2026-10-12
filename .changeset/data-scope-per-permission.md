---
"@harbour/api": patch
"@harbour/domain": patch
"@harbour/db": patch
"@harbour/sync": patch
"@harbour/contracts": patch
"@harbour/i18n": patch
"@harbour/web": patch
"@harbour/mobile": patch
---

Security fix: each permission now reaches only the people that the roles and grants giving it
reach. Before, a member of staff with two roles (for example a care worker at one home who also
views finance across the organisation) could open and add to care records at every home, and the
people anyone was assigned to, or had opened by break-glass, counted for everything they held.
Now the people you are assigned to count only for what your care worker role gives you, and
break-glass opens a record for reading only: the web offers no form on such a record and says
"You opened this record for reading only. To record something, tell the nurse in charge at this
home, or record it on paper and enter it when you have access.", the break-glass sheet says so
before it opens, and a person's document cannot be signed through it. The audit trail is shown
whole only to those who hold it across the organisation.

Clinical safety changes

- Some staff will see fewer people, and a few more. Before go-live, the Registered Manager reviews
  role bundles and grants with the pre-deployment access report
  (docs/runbooks/data-scope-per-permission-access-report.md), which lists everyone whose reach
  narrows or widens for the person's record and for each part of the phone's sync. Cover at
  another home is a role assignment at that home, until grants can be managed in the product.
- A grant with no location stops the database migration, naming how many, until each is ended or
  given a home: it used to apply wherever the member's roles reached, and making it reach the
  whole organisation would widen it.
- Care coordinators: the people and their care reference at their home still sync to the phone;
  recent notes and charts no longer do, because the role does not read care notes. The phone
  offers recording (notes, charts, body map) only for people its user may record about, and
  otherwise says "You can read this record but cannot record on it. If something needs
  recording, tell the nurse in charge." Add care note permissions to the coordinator's role if
  they need them.
- A person syncs to a phone only where the care reference does too, so the phone never shows a
  resuscitation decision or IDDSI level as not recorded when it is merely not on the phone.
- An urgent review of an entry the server refused goes to the nurse or senior in charge on site
  who can read the person's record and notes (a team leader, at a home with no nurse) and to
  whoever can act on the care plan; with no one at all, the gap is audited.
- Administrators, and any role that cannot open people's records, see in the task list only the
  tasks given to them that are about no one.
- A task about a person can be given only to someone who can open that person's record and do
  the task, and escalations and their fallbacks skip anyone who cannot, who has left, or whose
  role has ended, so the Registered Manager is told instead.
- Sync every device before deploying, so nothing written under the old reach is left on a phone
  that can no longer send it. Announce a cut-off; on each phone, Today shows a last sync after it
  and "No changes waiting to upload"; the device list (Registered Manager, deputy or owner) shows
  every device seen after the cut-off with nothing reported waiting. The runbook has a read-only
  query for devices not seen since.
