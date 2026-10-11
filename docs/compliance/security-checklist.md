# Security checklist

| Item | Value |
| --- | --- |
| Targets | [OWASP ASVS 5.0](https://github.com/OWASP/ASVS/releases) Level 2 for web and API; [OWASP MASVS](https://mas.owasp.org/MASVS/) at the L2 testing profile for mobile; NCSC guidance on [MFA](https://www.ncsc.gov.uk/collection/mfa-for-your-corporate-online-services/recommended-types-of-mfa), [passwords](https://www.ncsc.gov.uk/collection/passwords/updating-your-approach) and [logging](https://www.ncsc.gov.uk/guidance/introduction-logging-security-purposes) |
| Source requirement | Master prompt 5.3 |
| Organisational certifications | Cyber Essentials Plus ([requirements v3.2](https://ncsc.gov.uk/files/cyber-essentials-requirements-for-it-infrastructure-v3-2.pdf)), ISO 27001 and the annual external penetration test required for assured DSCR suppliers by the [IG uplift from 1 September 2026](https://nhse-dsic.atlassian.net/wiki/spaces/DSCR/pages/14095777793/Changes+to+Information+Governance+DSCR+-+ISO27001+and+Penetration+Testing) are Thapsus's work outside the codebase `[human action]`. This checklist is the control mapping and evidence index for them |
| Owner | Engineering lead; reviewed by the `security-reviewer` agent on PRs labelled `security` |

"Phase" is when the control lands. "Phase 0" means it is part of the Phase 0 foundations release and is confirmed at the Phase 0 gate (record the evidence in `docs/plans/phase-0.md`). "Evidence" names the test, CI job or document an assessor should look at.

## 1. OWASP ASVS 5.0 Level 2, chapter by chapter

| Chapter | Key Level 2 expectations | How Harbour meets it | Phase | Evidence |
| --- | --- | --- | --- | --- |
| V1 Encoding and Sanitization | Context-aware output encoding; parameterised queries; no dynamic code execution; safe handling of template and CSV/spreadsheet injection | React escapes output by default; `dangerouslySetInnerHTML` banned except for sanitised rich text; Drizzle parameterises SQL and raw SQL is restricted to reviewed migrations and RLS helpers; CSV exports prefix cells starting with `=`, `+`, `-`, `@`, tab or carriage return; Typst templates take data as values, never as markup | Phase 0 (React, Drizzle); CSV Phase 1 | Lint rules; export unit tests |
| V2 Validation and Business Logic | Input validated against a positive schema at trusted boundaries; business-logic limits; steps enforced in order; anti-automation | Zod schemas on every API input with unknown keys rejected; workflow states enforced in `packages/domain` (for example witness before a controlled-drug entry is saved); rate limits per user, tenant and IP | Phase 0 (Zod, API skeleton); rules per module | Contract tests; domain tests |
| V3 Web Frontend Security | Content Security Policy; HSTS; secure cookie attributes; framing control; strict CORS; no sensitive data in URLs | Strict CSP with nonces; HSTS; session cookies `Secure`, `HttpOnly`, `SameSite=Lax` and `__Host-` prefix; `frame-ancestors 'none'`; CORS allowlist; IDs, never names or NHS numbers, in URLs | Phase 0 (web shell headers) | Header tests in Playwright |
| V4 API and Web Service | Correct HTTP methods and content types; authenticated WebSocket and streaming connections; schema-first API | Hono with OpenAPI 3.1 generated from code; content-type enforced; PowerSync connections authenticated by short-lived JWTs | Phase 0 | OpenAPI diff in CI |
| V5 File Handling | Size and type limits; content-based type checks; malware scanning; no execution; safe download | Presigned uploads to S3 (SSE-KMS) with size limits; antivirus scan on ingest; EXIF stripping on images; downloads served with `Content-Disposition` and short-lived presigned URLs | Phase 1 | Upload integration tests |
| V6 Authentication | Strong password policy; breached-password check; MFA; throttling; secure recovery; notification of authentication changes | Passkeys (FIDO2) and TOTP apps; MFA mandatory for every role that can read care records; SMS only as a documented exception; passwords minimum 12 characters with a deny list, no composition rules, no forced expiry, paste allowed; throttling, not lockout; step-up re-authentication for controlled drugs, residents' money, data export and break-glass; users notified of new authenticators and sign-ins from new devices | Phase 0 (passkeys, TOTP, roles); step-up with each module | Auth integration tests |
| V7 Session Management | Server-side sessions; rotation on sign-in; idle and absolute timeouts; revoke all sessions; re-authentication for sensitive actions | Better Auth server-side sessions; session list and revoke for users and admins; device list and revoke; idle and absolute timeouts per role | Phase 0 (sessions); device management Phase 1 | Session tests |
| V8 Authorization | Deny by default; checks server-side on every request; object-level and field-level checks; tenant isolation | RBAC permissions `module.resource.action` plus attribute scoping (location, team, assignment, time window); every check in the API and again in Postgres RLS with `FORCE ROW LEVEL SECURITY` ([ADR-0002](../decisions/0002-tenancy-and-row-level-security.md)); break-glass with justification | Phase 0 (RLS, roles); scoping Phase 1 | RLS isolation suite (hazard HZ-011) |
| V9 Self-contained Tokens | Signature verified with an allowlisted algorithm; `iss`, `aud`, `exp` validated; short lifetimes; key rotation | PowerSync JWTs signed by the API, short-lived, verified against a JWKS with key rotation; claims limited to tenant, user, location and assignment IDs | Phase 0 (sync auth) | Sync auth tests |
| V10 OAuth and OIDC | Authorisation code with PKCE; exact redirect URIs; state and nonce; client credentials scoped | Enterprise SSO (SAML or OIDC) via Better Auth SSO plugin or WorkOS; public API OAuth2 client credentials per tenant with scoped tokens | SSO when an enterprise tenant needs it; public API Phase 6 | Contract tests |
| V11 Cryptography | Approved algorithms; managed keys; key management policy and inventory; secure randomness | AES-256 at rest (RDS, S3 SSE-KMS, backups); SQLCipher AES-256 on mobile; keys in AWS KMS and platform keystores; yearly rotation; CSPRNG only; no custom crypto; cryptographic inventory kept in this folder | Phase 0 (KMS, SQLCipher); inventory Phase 1 | Terraform; inventory document |
| V12 Secure Communication | TLS 1.2 or higher everywhere, including internal; certificate validation; no plaintext fallback | TLS 1.2+ at CloudFront and the load balancer; RDS connections require TLS; HSTS | Phase 0 (Terraform for dev) | TLS scan; Terraform plan |
| V13 Configuration | Secrets in a managed store; least-privilege service accounts; no default credentials; debug off in production | AWS Secrets Manager; OIDC deploy role, no long-lived cloud keys; gitleaks pre-commit and in CI; `.env.example` only; separate AWS accounts for dev, staging and prod | Phase 0 | gitleaks job; Terraform |
| V14 Data Protection | Classify sensitive data; keep it out of URLs, logs and caches; `Cache-Control: no-store` on sensitive responses; minimal client-side storage | No personal data in logs (opaque IDs only); `no-store` on API responses with personal data; web app keeps no personal data in `localStorage`; retention engine | Phase 0 (logging rule) | Log scrubbing tests |
| V15 Secure Coding and Architecture | Documented architecture and threat model; dependency management; SBOM; mass-assignment protection; safe concurrency | ADR-0001 and ADR-0002; threat model per module spec; Renovate, `pnpm audit`, licence allowlist; Syft SBOM and signed provenance per release; strict Zod objects; idempotent writes and optimistic versioning | Phase 0 (CI); threat models per module | CI security jobs |
| V16 Security Logging and Error Handling | Security events logged with UTC timestamps; logs protected; no sensitive data; generic errors to users | Authentication, authorisation failures, permission changes, exports and break-glass written to `audit_event` (append-only) and to security logs retained at least 6 months; pgAudit; stack traces never returned to clients | Phase 0 (`audit_event`, pgAudit config) | Audit tests |
| V17 WebRTC | Secure media and signalling | Not applicable: Harbour uses no WebRTC | Not applicable | |

## 2. OWASP MASVS, L2 testing profile (mobile)

MASVS v2 defines control groups; the levels L1, L2 and R are testing profiles in the OWASP MAS testing guide. Harbour targets L2 for all groups and adds selected resilience controls because the master prompt requires root and jailbreak detection.

| Control group | How Harbour meets it | Phase |
| --- | --- | --- |
| MASVS-STORAGE | Local database encrypted with SQLCipher (AES-256), key held in expo-secure-store with `requireAuthentication` and `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY` on personal devices; database excluded from device backups; no personal data in logs; screenshots blocked on record screens (Android `FLAG_SECURE`, iOS warning); clipboard disabled for identifiers | Phase 0 (SQLCipher store); remaining Phase 1 |
| MASVS-CRYPTO | Platform keystores only (iOS Keychain and Secure Enclave, Android Keystore); no hard-coded keys | Phase 0 |
| MASVS-AUTH | Server-side authentication; biometric unlock bound to a keystore key (`BIOMETRIC_STRONG`) with PIN fallback; auto-lock after 2 minutes on personal devices and 30 seconds by default on shared devices; step-up for sensitive actions. Shared devices: [kiosk.md](kiosk.md) | Phase 0 (biometric lock); kiosk Phase 1 |
| MASVS-NETWORK | TLS only; platform certificate validation; identity pinning for endpoints Thapsus controls (L2) | Pinning approach needs an ADR (rotation and recovery) `[ADR - engineering]`; Phase 1 |
| MASVS-PLATFORM | Deep links validated (tenant and person IDs re-checked, hazard HZ-001); no WebViews for record content; permissions requested at first use with an explanation; foreground-only location | Phase 1 |
| MASVS-CODE | Minimum OS versions enforced; app refuses writes and prompts update when more than one schema version behind; dependency scanning; EAS Update only for JavaScript and assets | Phase 1 |
| MASVS-RESILIENCE (beyond L2) | Root and jailbreak detection warns and blocks eMAR | Phase 2 (with eMAR) |
| MASVS-PRIVACY | Data minimisation (assigned people and next 7 days only); no third-party tracking or advertising SDKs; Apple privacy manifest and labels; Google Play Data safety form; in-app account deletion request flow | Phase 1 |

## 3. NCSC guidance

| Topic | NCSC guidance | Harbour |
| --- | --- | --- |
| MFA | Prefer phishing-resistant FIDO2 or passkeys, then authenticator apps; SMS is weaker | Passkeys and TOTP; SMS only as a documented exception per user, recorded with reason; MFA mandatory for all roles that can read care records |
| Passwords | Length over complexity; deny common and breached passwords; no forced expiry; allow paste and password managers; throttle rather than lock out | Minimum 12 characters; deny list; no expiry; paste allowed; throttling with increasing delay per account and per IP |
| Logging | Decide what to log, protect integrity, synchronise time, centralise, retain long enough to investigate | Security logs at least 6 months, UTC timestamps from synchronised clocks, tamper-evident (append-only table, pgAudit, write-once log storage), centralised in Grafana Cloud UK, scrubbed of personal data |

## 4. Vulnerability management and supply chain

| Control | Rule | Evidence |
| --- | --- | --- |
| Patching | Critical and high (CVSS 7 or higher) fixed and deployed within 14 days | Renovate PRs; release log |
| Static analysis and secrets | CodeQL, gitleaks on every PR | CI |
| Images and SBOM | Trivy image scan; Syft SBOM; no critical or high findings | CI |
| Dependencies | `pnpm audit`; licence allowlist (`pnpm check:licences`) | CI |
| Releases | Signed tags; signed SBOM and provenance attestation per production release | Release workflow |
| Penetration test | Annual external test `[Thapsus - human action]` | Report summary shared with tenants on request |

## 5. Human actions

| Action | Owner |
| --- | --- |
| Cyber Essentials, then Cyber Essentials Plus | Brian |
| ISO 27001 certification (starts Phase 2) | Brian |
| Annual external penetration test | Brian |
