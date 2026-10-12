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
break-glass opens a record for reading only: no tab of the record on the web (notes, charts, body
map, activities and visits, assessments, care plan, risk assessments, ReSPECT and advance care)
offers a form on such a record, and each says "You opened this record for reading only. To
record something in it, tell the person in charge of this shift or your manager, or record it on
paper and enter it when you have access."; the break-glass sheet says so before it opens, and a
person's document cannot be signed through it. Where your roles let you read a record but not
write to one part of it, that tab says so instead of offering a form the server would refuse; on
the charts tab, where you can still change the chart settings, it says only that you cannot
record entries. The audit trail is shown whole only to those who hold it across the organisation.

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
  otherwise says "You can read this record but cannot record in it. If something needs
  recording, tell the person in charge of this shift or your manager." A coordinator who also
  works as a care worker records about the clients assigned to them, as before: the sync token
  names those clients (up to 100; above that the phone records only about people at homes that
  sync just for them). Add care note permissions to the coordinator's role if they need more.
- Until a phone has had its first sync token after this update, or when it could not save what
  its user may record, it offers recording about no one and says "This phone could not save what
  you may record. Sync again to fix this." The server refuses anything it would not take; it keeps a copy of a refused entry only about someone the author could record about, so
  an entry about anyone else stays on the phone among the entries needing attention until someone
  removes it with a reason.
- A person syncs to a phone only where the care reference does too, so the phone never shows a
  resuscitation decision or IDDSI level as not recorded when it is merely not on the phone.
- An urgent review of an entry the server refused goes to the clinical leads and team leaders
  whose roles reach the person's home and who can read the person's record and notes (at every
  home; no rota is checked), and to whoever can act on the care plan there, or across the
  organisation only when no one holds that at the home; with no one at all, the gap is audited.
- An overdue task goes, besides its assignee, to the clinical leads and team leaders at its home;
  with none, to a Registered Manager whose role reaches it (there or across the organisation);
  with none, to whoever can act on the care plan and see the person. Escalation means someone
  other than the assignee is told: with no one else, the assignee is still reminded, but the task
  is not marked escalated, the gap is audited (once a day while it lasts) and it is tried again
  every hour. A task about a person takes the person's home when none is given. A step of an
  escalation chain no one holds goes to a Registered Manager reaching the home, else the owner,
  and one that can reach no one is audited; so is a break-glass alert no one active other than
  the person who opened the record can receive, and an overdue statutory notification no active
  member of staff can submit. A device's sync task is escalated only when someone other than its
  assignee is told. A task about a person can be placed only at the person's home.
- Each day, the operator receives one signal per organisation where safety work reached no one
  who could act, and tells the organisation's Registered Manager or owner the same working day.
  The signal, and another for any failed background job, are CloudWatch alarms defined with the
  infrastructure, live once it is applied (H-171). One organisation's failed background job no
  longer stops the escalations of the organisations after it.
- Only staff who have signed in (active) are told about anything: someone invited who has never
  signed in, suspended or who has left is never the one told, so the next in line is.
- Administrators, and any role that cannot open people's records, see in the task list only the
  tasks given to them that are about no one.
- A task about a person can be given only to someone who can open that person's record and do
  the task, and escalations and their fallbacks skip anyone who cannot, who has left, or whose
  role has ended, so the Registered Manager is told instead.
- Sync every device before deploying, so nothing written under the old reach is left on a phone
  that can no longer send it. Announce a cut-off; on each phone, Today shows a last sync after it
  and "No changes waiting to upload"; the device list (Registered Manager, deputy or owner) shows
  every device seen after the cut-off with nothing reported waiting. The runbook has a read-only
  query for devices not seen since, or never seen.
