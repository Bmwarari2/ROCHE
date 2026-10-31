# White-label branding (PLAT-002)

Branch `feat/web-branding`.

## What changed

- Domain (`packages/domain/src/platform/branding.ts`): `checkAccent` measures a tenant's accent
  against every surface it meets in the light and dark themes (`BRAND_THEMES`, which a web test
  keeps equal to the `@harbour/ui` tokens): white words on it and the accent on white and on black
  at 4.5:1, the other surfaces at 3:1. A colour that fails is refused as too light or too dark,
  with the nearest passing colour of the same hue (`adjustAccentForContrast`). `checkBrandName`
  trims the display name (at most 80 characters, no control characters). A new document category,
  `organisation_logo` (PNG or JPEG, 512 KB, never SVG), and `stripImageMetadata`, which removes
  EXIF, XMP, IPTC, comments and PNG text chunks from the logo before it is stored.
- API (additive): `GET /v1/branding` (any member), `PUT /v1/branding` (`platform.tenant.manage`;
  422 `brand_accent_contrast` saying why and which colour works, 409 when stale),
  `GET`, `PUT` and `DELETE /v1/branding/logo`, and `Me.tenant.logoDocumentId`. Audit events
  `platform.branding.updated` (refusals too) and `platform.branding.logo`. The general document
  routes neither accept nor serve a logo. OpenAPI and the client regenerated. No migration: the
  `tenant` columns already existed.
- Web: `/settings/branding` for `platform.tenant.manage` (the owner), in the sidebar. The colour is
  checked as it is typed, with each ratio in words, a one-step "Use #... instead" and a preview in
  both themes. The shell applies only an accent that passes again in the web tier (`--accent` and
  `--accent-hover`; never the focus ring or status colours), shows the display name for the active
  organisation and the logo, decorative, beside the product name (`AppBar` `brandLogoSrc`).
- Spec: [platform.md, white-label branding](../specs/platform.md#white-label-branding-plat-002).
  Not clinical; no personal data (a logo, a colour and an organisation's name), so the records of
  processing and data standards are unchanged.

- Review fixes: the display name refuses bidirectional and zero-width characters and is
  NFC-normalised; the logo has its own body limit and its refusals are audited; `/v1/me` sends only
  a passing accent and a clean logo id; the web logo route serves bytes only for the current logo
  document (`Vary: Cookie`); removing the logo asks first; the colour advice is announced once by a
  status after typing stops; the preview of "no accent" shows Harbour's own colour; nothing typed
  is cut off; the logo gives way in the app bar on phones. Security checklist V5 and V14 record the
  logo as the one cached file.

## What is next

- The database trigger `tenant_governance_guard` (migration 0063) does not cover `brand_name`,
  `brand_accent` and `logo_document_id`, so only the API enforces `platform.tenant.manage` for
  them; extending it needs a migration (the next free number).
- `app.memberships_for_auth_user` returns the registered name, so the organisation switcher and
  the "choose an organisation" page show other organisations by it; the active one shows its
  display name. Returning `coalesce(brand_name, name)` needs a migration.
- The logo on printed packs and letters (the PDF writer would need the transfer pack's image path)
  and branding on the invitation page.
- Mobile: apply the accent and logo in `apps/mobile`.
- Harbour's own default accent, `#0071e3`, is 4.47:1 on black, just short of the 4.5:1 that
  section 9.1 sets for a tenant accent; a token review (or an ADR) should settle it.
- The switcher could show the registered name beside a display name; a styled "Choose logo
  image" button in place of the browser's own file input (whose words are not translated).
- A logo quarantined because the scanner was down is not promoted when a later scan clears it;
  the owner is told to upload it again. A logo destroyed at the end of retention stops showing.

## Tests

- `packages/domain/src/platform/branding.test.ts`, `apps/api/test/branding.test.ts`,
  `apps/web/src/lib/branding.test.ts`, `packages/ui/src/components/AppBar/AppBar.test.tsx`.
- Journey `apps/web/e2e/branding.spec.ts` (axe in light and dark at every state; puts the demo
  tenant's branding back afterwards).
