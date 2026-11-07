---
status: "accepted"
date: 2026-11-06
decision-makers: Brian (owner, through the owner desk session on 06/11/2026)
consulted: engineering (Claude Code sessions)
informed: clinical safety officer (when appointed, H-20), data protection lead
---

# Owner decisions of 06/11/2026: provisional clinical safety answers, no SMS at launch, and the ten open questions

## Context and problem statement

Phase 2 has many questions only people can answer. Since 31/10/2026 every open question takes its
recommended answer ([ADR-0098](0098-production-on-google-cloud.md),
[recommended-answers.md](../plans/recommended-answers.md)), but ten owner questions had no default, and
about 280 items owned by the clinical safety officer (CSO) were simply "open", because no CSO is appointed
yet (H-20). On 06/11/2026 the owner answered both.

## Decision outcome

1. **Clinical safety officer items.** In the owner's words: "Sign off on any clinical safety officer work
   with recommendations, they will be reviewed during testing." Every open CSO-owned item in
   [human-actions.md](../plans/human-actions.md) takes its recommended answer, with the status
   "provisional: owner-accepted recommendation, pending CSO review at the testing phase". The hazard log
   says the same of every proposed rating, control and acceptance.
   - This is **not** a CSO signature or acceptance under DCB0129. No hazard becomes `controlled`, and
     the safety cases (H-24 for v0.0, H-545 and H-840 for v0.2) and the Phase 2 gate stay unsigned
     until a named, registered clinician is appointed as CSO (H-20) and reviews them, before any real
     tenant or production release.
   - The slice 85 gate record may be drafted, marked "drafted, CSO signature pending".
2. **No SMS at launch (H-09, H-105), against the recommendation.** Families get app and email
   notifications only. The `comms.sms` port and its mock adapter stay, and no gateway is contracted.
   Launch-facing copy, settings and guides stop offering SMS, and a lone-worker alarm route can no longer
   choose SMS while no gateway exists. That build change is follow-up work after batch 3c. SMS is
   reconsidered after launch, against H-105's criteria.
3. **The other eight open questions take their recommendation:** H-521 (manual right to work checks,
   then a GOV.UK-certified provider), H-522 (an umbrella body's DBS e-bulk service; Update Service checks
   only with consent), H-535 (starter policy templates stay drafts for the solicitor; a QCS import only
   under licence), H-569 (Medical store category), H-663 (the Google Cloud security monitoring set, CVSS 7+
   fixed within 14 days), H-664 (ISO 27001 clauses 4 to 10 as recommended), H-781 (outbreak reporting in
   England only until each nation pack) and H-829 (disclosure screens agreed at the testing phase).

### Consequences

- Development no longer waits on these questions; the testing-phase review still covers all of them.
- The hazard log's clinical approval row and every provisional item point here, so the difference between
  an owner-accepted recommendation and a CSO acceptance stays visible.
- Lone-worker routes that list SMS must not rely on it at launch; the follow-up change removes the option
  while the SMS capability is off, with a test.
