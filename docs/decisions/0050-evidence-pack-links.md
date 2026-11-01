---
status: "accepted; partly superseded by ADR-0098"
date: 2026-10-11
decision-makers: Claude Code (build), Brian (product owner, informed)
consulted: security-reviewer agent (first review and the fix pass); DPO to review the redaction rules and defaults (H-96)
informed: Brian
---

# Evidence pack links: hashed random tokens bound to one recipient by an emailed code

> **Partly superseded by [ADR-0098](0098-production-on-google-cloud.md) (production on Google
> Cloud), 31/10/2026**: the S3 and SES details. The rejected presigned S3 URL option would now be a
> Cloud Storage V4 signed URL (still rejected for the same reasons), and the code email goes through
> the SMTP provider still to be chosen (H-08). The token design is unchanged. The text below is kept
> as decided.

## Context and problem statement

The inspector evidence pack (master prompt 11.2, "PDF bundle, watermarked, time-limited link";
section 4, inspector role "read-only, time-boxed, watermarked exports") sends special category data
outside the provider. The link must expire, be revocable at once, open only for the person it was
sent to, and leave an audit trail of every open. How should the link be made and checked?

## Decision drivers

- Revocation takes effect on the next request, not when a signature happens to expire.
- A forwarded or leaked link is useless to anyone but the recipient.
- No personal data or long-lived secret in the URL; nothing an attacker can replay offline.
- Every open is audited in the tenant's chain (section 5.5); the bundle never leaves through an
  unaudited path.
- The same pattern as the About Me share links already specified (people.md rule 13: token hash
  only), so there is one way of doing it.

## Considered options

- An opaque random token stored only as a hash, checked against the database on every request,
  with the recipient proving their address by a one-time code; the PDF streamed through the API.
- A stateless signed token (HMAC or ES256, like the sync tokens) carrying the pack, recipient and
  expiry.
- A presigned S3 URL to the rendered PDF.

## Decision outcome

Chosen option: "opaque random token, hashed, with an emailed one-time code", because it is the only
option where revocation and recipient binding hold on every request and every open is audited.

1. **Token.** 256 bits from the platform's cryptographic random source, base64url in the link,
   shown once at release and stored only as its SHA-256 hash (`evidence_pack_link.token_hash`),
   compared in constant time.
2. **Binding.** Opening the link asks for a one-time code sent to the recipient's bound work
   address (never in the same message as the link). The code is `EVIDENCE_LINK_CODE_DIGITS` (6)
   digits from the cryptographic random source, stored only as a hash, compared in constant time,
   single-use and valid for `evidence_pack.code_valid_minutes` minutes (rate table policy, never
   more than `EVIDENCE_CODE_MAX_VALID_MINUTES`, 10). After `EVIDENCE_LINK_MAX_CODE_ATTEMPTS` wrong
   codes the link locks for good. The failed count never goes down, not even after a correct
   code, so a guesser cannot take turns with the real recipient. An inspector with a Harbour
   account may instead sign in, with MFA, as that recipient (`quality.evidence.read`, a
   care-record permission held by the inspector role alone).
3. **Session.** A correct code sets an HttpOnly, Secure, SameSite=Strict cookie for that link
   alone, holding the link and the verified address. It is a browser-session cookie (no
   Max-Age; amended on #113's security review): it goes when the browser closes, and the expiry
   sealed inside it (never past the link's) is checked on every request. The recipient can end it
   sooner with "Finish and remove access from this browser", which clears it. The verification lives in that session and
   never on the link row, so verifying in one browser opens nothing in another, and a forwarded
   link still needs its own code.
4. **Expiry.** `evidence_pack.link_expiry_days.default` days unless the sender chooses, never more
   than `.max` (tenant policy defaults in the rate table, marked to verify). Expiry and revocation
   are checked on every request (`evidencePackLinkAccess`).
5. **Delivery.** The watermarked PDF is streamed by the API with `no-store` and `attachment`
   disposition; it is never served from a presigned bucket URL. The bundle is deleted when the
   link expires or is revoked; the manifest stays.
6. **Release.** Step-up and a second person who did not shape the pack: not the composer, not
   anyone who redacted free text by hand and not any other editor (`evidencePackContributors`,
   checked by `checkEvidencePackRelease`).
7. **A new link is a release.** After a lock-out or a lost email, a new link needs the same
   checks as release (permission, step-up, a non-contributor, expiry within the maximum), goes to
   the same recipient only, and revokes the old link in the same transaction
   (`checkEvidencePackLinkReissue`). Without this rule a lock-out could be undone by the person who
   wrote the redactions, alone.

### Consequences

- Good, because revoking a link or locking it stops access at the next request.
- Good, because a forwarded link fails at the code step, and every code, failure and open is in
  the audit chain.
- Good, because a lock-out is permanent for that link and only a non-contributor with step-up can
  issue another, so guessing and a single insider both stop at the same place.
- Bad, because the recipient needs access to their mailbox to open the pack, and the provider needs
  working email (SES, H-08); a recipient without email gets the pack on paper.
- Neutral, because one database read per request is negligible at evidence-pack volumes.

### Confirmation

`packages/domain/src/quality/evidence-pack.test.ts` (`hazard HZ-050 the link opens only for its
recipient's own session, before expiry and revocation`; `hazard HZ-050 one-time codes`; `hazard
HZ-050 issuing a new link is a release`; `hazard HZ-050 releasing a pack: nobody who shaped it may
release it`). The API step adds tests that the token and codes are stored hashed, the bundle route
refuses without a session for that link, the cookie flags are set, a re-issue revokes the old link
and the bundle is deleted at link end; the security-reviewer agent reviews the public routes.

## Pros and cons of the options

### Opaque random token, hashed, with an emailed one-time code

- Good, because revocation, expiry and lock-out are database state, effective immediately.
- Good, because the URL carries no information and the database holds no usable token.
- Bad, because it needs a code delivery step and a database lookup per request.

### Stateless signed token

- Good, because no lookup is needed to validate the signature.
- Bad, because revocation needs a deny-list lookup anyway, so the statelessness buys nothing.
- Bad, because the payload (pack, recipient, expiry) travels in the URL and key rotation
  invalidates every live link.

### Presigned S3 URL

- Good, because it is simple and offloads delivery.
- Bad, because it cannot be revoked before it expires (short of deleting the object or rotating
  credentials), cannot be bound to a recipient, and opens are not in the tenant's audit chain.

## More information

Related: [quality.md](../specs/quality.md) rules 6 to 10, ADR-0030 (browser security), ADR-0031
(document storage), hazard HZ-050. Revisit if CQC offers an evidence submission API, which would
replace links for CQC recipients.
