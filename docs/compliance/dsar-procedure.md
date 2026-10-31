# Subject access request procedure

| Item | Value |
| --- | --- |
| Law | UK GDPR Art 12 and 15, as amended by the [Data (Use and Access) Act 2025](https://www.legislation.gov.uk/ukpga/2025/18/contents) (searches need only be reasonable and proportionate; the time limit starts on receipt of the request, any identity information or fee, and pauses while awaiting clarification); DPA 2018 Schedules 2 and 3 (exemptions, including third-party data and the health and social work data serious-harm tests) |
| Who responds | The **tenant** (controller). Thapsus (processor) assists and never responds substantively to a request about tenant data |
| Tooling | DSAR workbench in Harbour (phase per [feature register](../specs/feature-register.md)) |

## 1. Thapsus as processor

| Step | Action | Time |
| --- | --- | --- |
| 1 | Any Thapsus staff member who receives a request about a tenant's data (by email, support ticket, phone, social media) logs it in the support system as `DSAR` | Same working day |
| 2 | Pass the request to the tenant's DPO or named lead through the in-app notice and by email, with the date received. Do not confirm whether the tenant holds data about the person | Within `[2]` working days (DPA clause 7.2) |
| 3 | Tell the requester only that the request has been passed to the care provider, which is responsible for the reply | Same time as step 2 |
| 4 | If the tenant asks for help beyond the workbench (for example locating data in backups), support provides it under the approval-ticket process; every action is audited | As agreed |

Requests about Thapsus's own data (as controller: customer contacts, Thapsus staff) follow this procedure's tenant steps, owned by the Thapsus DPO lead.

## 2. The tenant as controller

| Step | Action | Notes |
| --- | --- | --- |
| 1. Recognise | A request can be made verbally or in writing, to any member of staff, and need not mention data protection | Staff log it in Harbour (DSAR workbench, "New request") on the day received |
| 2. Log and start the clock | Record requester, data subject, channel, date received. The workbench sets the due date at one month | The clock starts on receipt, or on receipt of identity information if that is needed |
| 3. Verify identity and authority | Ask only for what is proportionate. For representatives, check authority: LPA (health and welfare, or property and finance as relevant), deputyship order, or the person's written authority. Where the person lacks capacity, consider their best interests | The workbench pauses the clock while awaiting identity information |
| 4. Clarify if needed | If the request is unclear or covers a large amount of information, ask the requester to clarify | The clock pauses while awaiting clarification (DUAA 2025) |
| 5. Extend if justified | Extend by up to two further months if the request is complex or there are several from the same person; tell the requester within the first month, with reasons | Workbench records the extension and reason |
| 6. Search | The workbench collects every record about the person across modules (care, medicines, incidents, safeguarding, documents, messages, audit references, portal activity). The case lists the tables it could not search and records reached only through another record (an incident's answers, a handover's items): check those from what was collected. Add any paper or external records. Searches must be reasonable and proportionate | Record what was searched |
| 7. Review and redact | Redact third-party information unless the third party consents or it is reasonable to disclose without consent; staff names acting in their professional role are usually disclosed. Apply the health and social work data serious-harm tests where relevant, taking the opinion of an appropriate health professional where the law requires it. Record each exemption used | Workbench redaction tool keeps an unredacted master and a redaction log |
| 8. Respond | Provide the data, the supplementary information in Art 15(1) (purposes, categories, recipients, retention, rights, source, automated decision-making) and the right to complain to the ICO, in a secure, accessible format (electronic by default if requested electronically) | Workbench exports a bundle; delivery by secure link |
| 9. Close | Record date sent, what was withheld and why, and any complaint | Kept under the retention schedule |

## 3. Special cases

| Case | Approach |
| --- | --- |
| Staff DSAR | Same procedure; HR records, rota, training, supervision and audit references are in scope; management information about other staff is redacted |
| Family member asking about a living relative | Only with the person's authority or legal authority (LPA, deputy); otherwise it is not a subject access request |
| Deceased person | Not covered by UK GDPR. Requests for health records of a deceased person fall under the Access to Health Records Act 1990 (personal representative or a person with a claim); take advice |
| Manifestly unfounded or excessive request | May refuse or charge a reasonable fee, with reasons and the right to complain; record the decision |
| Request also asks for erasure or rectification | Handle each right separately ([retention-and-deletion.md](retention-and-deletion.md) for erasure) |

## 4. Records kept

Every request, its clock history, searches, redactions, exemptions and the response are kept in the DSAR register in Harbour, available to the tenant's DPO and reported in the monthly data protection summary.
