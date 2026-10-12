---
"@harbour/api": patch
"@harbour/domain": patch
---

Security fix: each permission now reaches only the people that the roles and grants giving it
reach. Before, a member of staff with two roles (for example a care worker at one home who also
views finance across the organisation) could open and add to care records at every home. Some
staff will now see fewer people, and administrators see only the tasks given to them.
Registered Managers should check that each role carries the permissions its holders need where
they work, and use a time-limited grant at a home when someone covers there.
