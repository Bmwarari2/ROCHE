# Medicines record screens (Phase 2 slice 52)

Branch `feat/web-medicines-record`, cut from `feat/meds-record-schema` (a92aec5a) and merging after
it. MEDS-001 web; MEDS-006 partly (self-administration is not in slice 16's API: H-1281).

## What changed

- Web: the person record's **Medicines** tab, for the API's three readers. The entries in force or
  scheduled, each with its state as an icon and a word (Not yet checked, Checked, Difference found,
  Stopped, Replaced, Withdrawn) and its directions exactly as the domain words them. One entry with
  every version, a withdrawn one struck through with its reason; the second check, offered only to
  someone other than the transcriber; stopping with when, why and the instruction's source.
- Transcription: the product found in dm+d by searching, the route and dose unit only from what dm+d
  permits, regular or when-required directions, doses sent exactly as typed.
- Reconciliation: started for an outstanding admission, transfer or return, or for a change; then
  sources, lines as written, a person's decision for every entry and line, and completion. Harbour
  decides nothing.
- The person (name, date of birth, NHS number) and their allergies sit beside every form; Harbour
  never matches them.
- API: `GET /v1/medicines/products` on the dm+d port; demo competence with the fixtures on.
- Docs: medicines.md section 13, human actions H-1280 to H-1285.
