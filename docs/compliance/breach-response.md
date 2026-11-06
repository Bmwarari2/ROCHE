# Personal data breach response

| Item | Value |
| --- | --- |
| Law | UK GDPR Art 33 (notify the ICO within 72 hours; processor notifies controller without undue delay), Art 34 (tell individuals when high risk), Art 33(5) (record every breach) |
| Guidance | [ICO: personal data breaches, a guide](https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach/personal-data-breaches-a-guide/) |
| Related | [Incident response runbook](../runbooks/incident-response.md) (security and service incidents, severity, comms) |
| Owner | `[Thapsus DPO or named lead - human action]`; on-call incident commander for the technical response |

A **personal data breach** is a breach of security leading to the accidental or unlawful destruction, loss, alteration, unauthorised disclosure of, or access to, personal data. It includes loss of availability (for example an outage that stops staff seeing care records) and integrity (records altered or lost), not only disclosure.

## 1. Clocks

| Clock | Starts | Duration | Owner |
| --- | --- | --- | --- |
| Thapsus to tenant (processor to controller) | When Thapsus becomes aware of a breach affecting tenant data | Without undue delay; contractual target `[24]` hours ([DPA clause 8.2](dpa-article-28-template.md#8-assistance-with-security-breaches-dpias-and-prior-consultation-art-283f-arts-32-to-36)) | Thapsus DPO lead |
| Tenant to ICO | When the tenant becomes aware (a reasonable degree of certainty that a breach has occurred), including through Thapsus's notification | 72 hours, unless the breach is unlikely to result in a risk to individuals; if information is incomplete, report within 72 hours and provide the rest in phases | Tenant DPO |
| Tenant to individuals | When a high risk to individuals is established | Without undue delay | Tenant DPO |

The breach register in Harbour shows these clocks for each breach (master prompt 5.1).

## 2. Thapsus (processor) steps

| Step | Action | Who |
| --- | --- | --- |
| 1. Detect and declare | Any alert, report or observation that personal data may have been affected is raised as an incident ([incident response](../runbooks/incident-response.md)); the incident commander tags it `possible breach` | Anyone; on-call |
| 2. Contain | Stop the exposure: revoke credentials or sessions, block the route, disable the feature flag, isolate the host, preserve evidence (logs, snapshots) before changing systems | Incident commander |
| 3. Assess scope | Which tenants, which data categories, how many people and records, what happened, when it started and ended. Use `audit_event`, pgAudit and access logs. Record "aware at" time | Incident commander with DPO lead |
| 4. Notify each affected tenant | In-app breach notice to the tenant's DPO and Owner roles (creates an entry in the tenant's breach register automatically) plus email to the breach contact. Do not wait for complete information | DPO lead |
| 5. Support | Provide updates as facts emerge, an evidence pack for the tenant's ICO report, and a draft notice for individuals if needed | DPO lead |
| 6. Record | Thapsus's own breach log entry, root cause, actions, lessons; hazard log review if there was clinical impact (for example HZ-011) | DPO lead; CSO if clinical |

**Notification content** (Art 33(3), sent as available): nature of the breach, categories and approximate numbers of people and records, likely consequences, measures taken or proposed, Thapsus contact, and what the tenant needs to do.

## 3. Tenant (controller) steps

| Step | Action |
| --- | --- |
| 1. Log | Every breach goes in the Harbour breach register, whether or not it is reportable (Art 33(5)) |
| 2. Assess severity | Use the register's assessment: data sensitivity (special category, safeguarding information, location of a person at risk), volume, ease of identification, consequences (distress, discrimination, physical harm, financial loss, loss of confidentiality), vulnerability of the people affected, containment |
| 3. Decide on reporting to the ICO | Report unless the breach is unlikely to result in a risk to individuals. Record the reasoning either way. Organisations using the [Data Security and Protection Toolkit](https://adultsocialcare.standards.nhs.uk/published-standards/data-security-and-protection-toolkit) can use its incident reporting tool; check its current arrangements for passing reports to the ICO |
| 4. Decide on telling individuals | Required where there is a high risk to their rights and freedoms. Use the data-subject notice template in Harbour: plain English, what happened, what it means for them, what has been done, what they can do, who to contact |
| 5. Consider other notifications | CQC (if the breach affects safe running of the service), police, the local authority safeguarding team, commissioners under contract, insurers |
| 6. Review | Actions, lessons, policy and training changes; close the register entry |

## 4. Severity guide for the register

| Level | Example | Typical decision |
| --- | --- | --- |
| Low | Email with a person's first name sent to the wrong colleague in the same organisation, deleted unread | Log only |
| Medium | Care record of one person seen by a staff member without a care relationship (no further disclosure); any identifiable detail of one person receiving care sent outside the organisation, even without health data, since receiving care itself reveals health (H-611) | Assess; often reportable to the ICO given special category data and the vulnerability of the people affected |
| High | Records of several people disclosed outside the organisation; device lost without encryption confirmation; cross-tenant exposure | Report to the ICO; consider telling individuals |
| Critical | Large-scale disclosure, safeguarding information or the location of a person at risk disclosed; ransomware with loss of availability of care records | Report to the ICO; tell individuals; consider police and CQC |

## 5. Templates in Harbour

- Processor-to-controller breach notice (automatic, in-app and email).
- Tenant ICO report worksheet (mirrors the ICO's online form fields).
- Data-subject notification letter (plain English, easy-read version).
