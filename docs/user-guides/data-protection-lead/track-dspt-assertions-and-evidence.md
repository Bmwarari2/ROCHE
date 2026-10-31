# How to track DSPT assertions and their evidence

Track where your Data Security and Protection Toolkit (DSPT) assertions stand for the year, and
link your organisation's documents to each as evidence. The **Data security** page shows the
toolkit, your certificates and your registers together.

These screens arrive with the next merge; until then they are on the `feat/quality-dashboard-pir`
branch.

**Who can do this**: the owner and the quality and compliance lead, or anyone given data
protection for the whole organisation. A Registered Manager or deputy manager, who works for one
location, cannot: the page says data security is for people who handle data protection for the
whole organisation.

**Register row**: QUAL-012.

## See where things stand

1. In the side bar, choose **Data security**.
2. Under **Data Security and Protection Toolkit** (the year), read the status: **Submitted**,
   **Due by**, **Due soon: by** or **Overdue: was due**, with the deadline.
3. Read how many assertions are tracked and how many are **Not started**, **In progress**, **Met**,
   **Not met** and **Not applicable**.
4. **Certificates and registration** shows Cyber Essentials, Cyber Essentials Plus and the ICO
   registration. **Registers** shows open breaches, breaches past the 72-hour ICO clock and open
   data protection complaints.

## Add an assertion

1. On **Data security**, choose **View the assertions**.
2. Under **Track another assertion**, enter the **Assertion number** as the toolkit numbers it, for
   example 1.1.1, and **What the assertion says**.
3. Choose **Add assertion**. The page says "Assertion added."

## Link evidence to an assertion

1. On **DSPT assertions**, find the assertion.
2. Under **Link evidence to** (the number), choose an **Organisation document**.
3. Choose **Link evidence to** (the number). The page says "Evidence linked."

To stop using a document, choose **Stop using** (the document) **as evidence for** (the number).
The page says "Evidence no longer used. The history keeps it."

## Change where an assertion stands

1. Under **Where** (the number) **stands**, choose **Not started**, **In progress**, **Met**, **Not
   met** or **Not applicable**.
2. For **Not met** or **Not applicable**, write **Notes** to say why.
3. Choose **Save where** (the number) **stands**. The page says "Assertion updated."

## Important

- **Met needs evidence.** Harbour refuses **Met** with no evidence linked. If the last document is
  removed from a met assertion, you must first tick a box saying it will then show as met with no
  evidence. The overview and the assertion then say **Met, but with no evidence**.
- Evidence must be one of your organisation's own documents, never a document about a person. If
  there are none left to link, the page says to add one to your documents first.
- This is your own record of the toolkit. Harbour does not submit anything to the toolkit for you.
- The rules: [quality spec section 17, rules 29 to 31](../../specs/quality.md#17-phase-2-domain-rules-slice-8-qual-001-002-004-005-006-008-012),
  [section 18, data security evidence](../../specs/quality.md#18-data-security-evidence-slice-32-qual-012)
  and section 21 of the quality spec on the `feat/quality-dashboard-pir` branch.
- For the breach register, see [How to record and handle a data breach](record-a-data-breach.md).
