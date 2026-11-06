# Crypto-shredding screens and signed certificate PDFs (PLAT-012 part 2)

Branch `feat/web-retention-shred`, cut from `feat/platform-crypto-shred` (f6577c4e) and merging
after it. Finishes PLAT-012.

## What changed

- Web: **Records retention** links to **Shred the organisation's records**: what a shred does in
  plain words, legal holds in force as blockers, the request (a recent full export, a reason, an
  acknowledgement) and every request with its state as an icon and a word. One request page for
  approving (the consequences again, the typed word `SHRED`, an acknowledgement) or refusing (a
  reason), cancelling one's own request or withdrawing a lapsed one. Certificates open on their own
  page with their signature check, download as a PDF and show the check as data.
- API: `POST /v1/retention/shred-requests/{id}/refuse` (a second person, step-up, within 7 days,
  a reason; final), `GET /v1/retention/shred-exports`, `GET /v1/destruction-certificates/{id}` and
  `/pdf`. Requests carry `expiresAt`, `lapsed`, `decisionReason` and both people's display names.
- Database: migration 0130 adds the `refused` status and `decision_reason`, with the decide policy
  and the guard redefined from 0117.
- The certificate PDF is built on request by the API's PDF writer, never stored
  (retention-and-deletion.md section 5 updated).
- E2E seed: Closing Example Care, an invented organisation with two records leads, so the journey's
  approval never shreds the demo organisation.
- Docs: platform.md rules 7 to 12, a data protection lead guide, human actions H-1220 to H-1225.
