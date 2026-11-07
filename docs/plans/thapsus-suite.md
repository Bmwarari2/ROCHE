# Thapsus suite: what joining it means for Thapsus Care (plan)

Status: plan for the owner to approve, 07/11/2026. Nothing here is built, and nothing here changes Thapsus Care
for a provider that does not link to another Thapsus product. Every link is off by default.

## 1. Why

On 07/11/2026 the owner asked for three new products: Thapsus Finance (`Bmwarari2/PROJECT_MULLAH`), Thapsus CRM
(`Bmwarari2/PROJECT_BOSSMAN`) and Thapsus ERP (`Bmwarari2/PROJECT_KASONGO`). All five Thapsus products,
including Thapsus Care and Thapsus-HR, must work together when a provider buys more than one, and the interface
must be consistent across all of them.

The suite plan lives in `docs/suite/` of `Bmwarari2/PROJECT_ATLAS`, the suite's platform repository (created by the
owner on 07/11/2026), with read-only copies in the three new product repositories (`SUITE_PLAN.md`,
`INTEGRATION.md`, `PLATFORM.md`, `STUDIO.md`, `AI.md`, `DESIGN_SYSTEM.md`). Its integration contract is built on the pattern
Thapsus Care set with Thapsus-HR in [ADR-0126](../decisions/0126-thapsus-hr-link.md): one owner for each kind of
data, identifiers on the wire and data fetched over the public API, the same region only, staleness said in
words, and off by default.

## 2. Owner decisions that touch Thapsus Care

| Decision (07/11/2026) | Effect on Thapsus Care |
| --- | --- |
| One shared design system; each product keeps its own accent | Thapsus Care keeps its blue. It moves onto the shared tokens through a token bridge, behind its visual tests. `#0071e3` stays for fills; text links keep `#0066cc`, because `#0071e3` is 4.31:1 on the shared soft-grey surface. `@harbour/ui-native` becomes the source of the shared native token build. |
| Installable web apps first for the new products; a native app later, reusing Care's Expo and offline stack | Care's mobile stack (Expo, PowerSync, SQLCipher) becomes the reference for the suite's later native apps. Nothing changes in Care's app. |
| Thapsus Finance holds the only general ledger in the suite | Thapsus Finance becomes one more accounting target for Care's finance context (section 14.2 "Accounting sync"), next to Xero, Sage and QuickBooks. |
| Data stays in its home region; Care is UK only | Care links only to UK workspaces of the other products, checked on connecting and on every sync (ADR-0126 rule 1, applied to every product). |

## 3. Links Thapsus Care would gain

| Link | What crosses | What never crosses | When |
| --- | --- | --- | --- |
| Care → Thapsus Finance | Funder and self-funder invoices, credit notes, receipts and remittances as accounting events, with cost centres per location; residents' money control totals after the monthly reconciliation is signed | Care records, funding assessments, anything about a person's care. A self-funder or family payer crosses only as a debtor: name, billing address and reference | With Phase 3 (money and buildings), once Finance's posting contract is live |
| Thapsus Finance → Care | Payment status of each invoice | — | Same |
| Care ↔ Thapsus ERP (optional) | Purchase requisitions for consumables, catering and facilities; stock levels at locations; maintenance work orders | Medicines stock (stays in Care, clinical, ADR-0103); anything about the people supported | Later, after Phase 3 |
| Care → Thapsus CRM (optional) | Commissioner, referrer and supplier relationships as business accounts | Enquiries about prospective residents, which hold health information and stay in Care | Later |
| Care ↔ Thapsus-HR | As built under ADR-0126 and ADR-0131 | As there | Existing |

Care's own modules stay whole for a provider without these products: its purchasing (section 14.4), its accounting
exports and its enquiries pipeline are unchanged.

## 4. Proposed work in Thapsus Care (slices for the lead session to schedule)

| # | Item | Depends on |
| --- | --- | --- |
| S.1 | Store the suite organisation id on the tenant and register it in the suite directory (no personal data) | Suite directory |
| S.2 | Accept Thapsus ID as a sign-in method through Better Auth's OpenID Connect support, with MFA rules unchanged (section 5.3) | Thapsus ID |
| S.3 | Generalise the Thapsus-HR link port into a partner-link port, so the same connection, mapping, delivery log, staleness and quarantine tables serve Finance, ERP and CRM | — |
| S.4 | Thapsus Finance as an accounting target: map invoices, credit notes and receipts to accounting events; cost centres per location; payment status back | Finance posting contract |
| S.5 | Design token bridge, then the shared shell and app switcher | Shared tokens and shell |
| S.6 | ERP and CRM links (optional, later) | ERP and CRM Stage 3 |

Each slice follows the usual rules: spec first, the hazard log reviewed for anything that can affect care (none of
S.1 to S.4 can, but S.6's stock link must be reviewed against medicines and consumables), and
`docs/compliance/records-of-processing.md` and `docs/specs/data-standards.md` updated where personal data
crosses.

## 5. What does not change

- UK residency, forced row-level security, audit, clinical safety and the medical-device boundary.
- The AI rules: off by default, advisory only, through the AI gateway. The suite AI framework (`AI.md`) follows the
  same rules and adds nothing that Care must use.
- Care's own release train: suite slices arrive as planned work with ADRs, never as a rewrite.
