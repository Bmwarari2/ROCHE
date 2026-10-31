# How to copy the PIR figures

Harbour gathers figures for your Provider Information Return (PIR) to CQC for one location over the
last 12 whole months. You check them and copy them into the return yourself.

These screens arrive with the next merge; until then they are on the `feat/quality-dashboard-pir`
branch.

**Who can do this**: the Registered Manager and the deputy manager for their own locations; the
owner, the group executive and the quality and compliance lead for every location. Care workers,
senior carers and nurses cannot.

**Register row**: QUAL-006.

## Steps

1. In the side bar, choose **PIR figures**.
2. Choose the **Location** and choose **Show figures**.
3. The heading names the location and the dates of the last 12 whole months.
4. Each key question (**Safe**, **Effective**, **Caring**, **Responsive**, **Well-led**) has a table
   with:
   - **Data point**;
   - **Answer**, with the number of records it comes from;
   - **Status**: **Prefilled** or **To complete**;
   - **Where it comes from**, or why it is to complete.
5. Check each prefilled figure against your own records.
6. Under **Figures to copy**, choose **Copy figures**. It says **Figures copied**. Or select the
   text in the box below it.
7. Paste the figures into the return on the CQC portal, and complete the data points marked **To
   complete** from your own records.

## Important

- **Harbour does not submit your return.** Nothing is sent to CQC. The Registered Manager copies
  the figures across and stays responsible for the return.
- A data point Harbour does not record yet says "Not recorded in Harbour yet: complete it from your
  own records." It is never filled with 0.
- A small number is withheld so that no one can be identified, and marked to complete.
- The data points are Harbour's mapping to CQC's questions. Until they are confirmed against the
  current return, the page says so.
- The rules: [quality spec section 17, rules 23 and 24](../../specs/quality.md#17-phase-2-domain-rules-slice-8-qual-001-002-004-005-006-008-012),
  and section 22 (rule 43) of the quality spec and hazard HZ-129, both on the
  `feat/quality-dashboard-pir` branch.
