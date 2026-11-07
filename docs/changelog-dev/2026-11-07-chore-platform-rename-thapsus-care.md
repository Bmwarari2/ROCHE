# The product is called Thapsus Care (ADR-0127)

- Every name people read changes from Harbour to Thapsus Care: the web and mobile words (en-GB and
  Welsh catalogues, page titles), the mobile app's home-screen name and permission prompts, the
  authenticator issuer and passkey display name (new enrolments; existing passkeys keep working, as
  the relying party id does not change), email text, API messages and the OpenAPI title, the user
  guides, specs, safety case, hazard log, records of processing, DPIA and the rest of `docs/`.
  2,885 changes in 363 files by `scripts/rename-product.mjs --apply`.
- Kept: `@harbour/*`, `HARBOUR_*`, the `harbour_*` database roles, `x-harbour-tenant`, the deep link
  scheme `harbour`, the Expo slug and bundle ids, `PASSKEY_RP_ID`, cloud and Terraform names, code
  comments, migrations already on `main`, ADRs and changelog history, and the invented demo names
  ("Harbour House" and the rest).
- Migration 0152 renames stored rows: the starter audit templates' source, and the global rate
  table and retention schedule sources and notes (a re-seed from the renamed documents gives the
  same). Tenants' own rows keep their words. Database test `product-name-stored-rows.test.ts`.
- The master prompt records the decision; the phase 1 gate's iOS build names `ThapsusCare`, the
  project Expo's prebuild makes from the new name.
- `smtp.test.ts` checks the decoded email body, since quoted-printable folds the longer line.
- CI: `node scripts/rename-product.mjs --check` fails if the old name comes back where people read
  it.
- Human actions H-1511 (trade mark and store name checks), H-1512 (domain and email sender name)
  and H-1513 (listings, privacy notice, DPIA wording, pilot notice).
- Reviews: the HZ-133 tests refuse any "Thapsus" other than the product's own name, in every state
  and in accessible names; demo names the pass had renamed are restored; wording that named the
  product twice or called the supplier "Thapsus" is clearer. CSO items H-1514 to H-1516.
