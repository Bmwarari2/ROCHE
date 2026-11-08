# Copy fixes from the slice 83 guides review

Branch `fix/web-guide-copy`, from `main` at `daa038a7`. Item 6 of the lead's list of gaps the
guides review found (the guides builder logs the review's H-rows from H-1543).

## What changed

- **Import undo (HZ-005, HZ-130)**: the undo button, its explanation and the "can be undone until"
  line name what the import added: "Withdraw 3 medicines" (kept in the medicines record, marked
  withdrawn), draft care plans, staff file checks or people. A medicines import no longer says
  "Remove 3 people".
- **Missing person**: the CQC prompt is shorter and says what to do: the notification is needed
  without delay, completed or recorded as not needed in the notification centre. The care worker
  guide names the police case too.
- **Recording a death**: the hint for an unexpected death says to make sure 999 and the police have
  been called, and that a doctor or the medical examiner usually refers to the coroner, though
  anyone worried can; it no longer says the coroner is the home's business alone. The senior carer
  guide says the same.
- **Disclosures**: plain words for the second factor ("your passkey or a code from your
  authenticator app") and the approval permission ("someone who may approve disclosures"); "did
  not log it", not "did not prepare it".
- **Outbreaks**: one name, "outbreak report", where the screens said "UKHSA report" (the
  notification centre already says "Outbreak report to the health protection team").
- Welsh copies follow the English and stay marked untranslated.
- **Tests and hazards**: `clinical-copy.test.ts` pins the CQC prompt and the death hint (HZ-013);
  `imports.test.ts` each undo type, an unknown type, and the singular (HZ-005, HZ-130); hazard log
  rows for HZ-005, HZ-013, HZ-127 and HZ-130; human actions H-1564 to H-1566.
- **Reviewers**: accessibility (no blocker; its high, an unknown import type reading as people,
  fixed) and clinical safety (no blocker; its high, the death hint, and mediums fixed).
