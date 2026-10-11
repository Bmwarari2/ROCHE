# Data protection complaints

| Item | Value |
| --- | --- |
| Law | Data Protection Act 2018 as amended by the [Data (Use and Access) Act 2025](https://www.legislation.gov.uk/ukpga/2025/18/contents): controllers must facilitate data protection complaints, acknowledge them within 30 days of receipt, take appropriate steps to respond without undue delay (including making enquiries), keep the complainant informed and tell them the outcome |
| In force | 19 June 2026 ([ICO: new data protection complaints law now in force](https://ico.org.uk/about-the-ico/media-centre/news-and-blogs/2026/06/new-data-protection-complaints-law-now-in-force/)) |
| Who handles | The **tenant** (controller) for complaints about its processing. Thapsus forwards any it receives. Thapsus handles complaints about its own processing as controller |
| Tooling | In-product data protection complaint form, register and outcome tracking (phase per [feature register](../specs/feature-register.md)) |

## 1. What Harbour provides

| Feature | Detail |
| --- | --- |
| Complaint form | In the person and family portals, the staff app ("Data protection, Make a complaint") and a public link the tenant can put in its privacy notice. Accessible (WCAG 2.2 AA), plain English, with an option to ask for help or another format. Also usable by staff to log a complaint received by phone, letter or in person |
| Acknowledgement | Automatic acknowledgement on submission through the form; for complaints logged by staff, the register shows a 30-day acknowledgement clock and escalates to the DPO before it expires |
| Register | Complainant, data subject (if different), what the complaint is about (access, accuracy, sharing, security, retention, other), date received, acknowledgement date, enquiries made, updates sent, outcome, date closed, link to any DSAR, breach or rectification |
| Updates and outcome | Templates for progress updates and the outcome letter, which tells the complainant they can complain to the ICO if dissatisfied |
| Reporting | Monthly count and themes for the tenant's DPO and governance meeting |

## 2. Tenant procedure

| Step | Action | Time |
| --- | --- | --- |
| 1 | Log the complaint in the register (automatic for the form) | Day received |
| 2 | Acknowledge receipt | Within 30 days of receipt (aim for 3 working days) |
| 3 | Investigate: make enquiries, review audit history and records, involve the DPO | Without undue delay |
| 4 | Keep the complainant informed of progress | At least monthly while open |
| 5 | Tell the complainant the outcome, any action taken, and their right to complain to the ICO | When concluded |
| 6 | Record lessons and actions; link to policy or training changes | On closure |

## 3. Thapsus procedure

| Situation | Action |
| --- | --- |
| Complaint about a tenant's processing reaches Thapsus | Log in support as `DP complaint`; forward to the tenant's DPO in-app and by email within `[2]` working days; tell the complainant it has been passed to the care provider, which is responsible |
| Complaint about Thapsus's own processing (as controller) | Follow the tenant procedure above, owned by the Thapsus DPO lead `[human action]` |
| Complaint about how Harbour works (for example a feature makes rights hard to exercise) | Forward to the tenant, and also raise a product issue labelled `data-protection` |
