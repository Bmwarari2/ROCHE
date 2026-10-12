# Lane D: platform carry-overs, then slice 14

Scope over the lane (STATUS "Next items" Phase 0 follow-ups; `docs/specs/platform.md`
"Later" lines; `docs/plans/phase-1.md` slice 14):

- Phase 0 follow-ups: invitations and the MFA enrolment flow end to end (Better Auth,
  `apps/api/src/auth/better-auth.ts`; ADR-0009, ADR-0030); admin session revoke and idle timeouts
  per role; the record history PDF export (signed, as section 5.5 asks; PDF writer of ADR-0040);
  device push registration (Expo push; ADR-0060); the OpenFeature provider over the existing
  flag catalogue (`packages/domain/src/platform/feature-flags.ts`, PLAT-003; Flagsmith optional,
  off unless configured, AI flags stay off by default); the operator console web UI and the
  read-only impersonation session (needs a tenant approval ticket, visible to the tenant).
- Then slice 14: privacy manifest and data safety, the account deletion flow, listing copy, the
  clinical safety case v0.1 (`docs/clinical-safety/safety-case/`), **user guides per role**
  (these move register rows to `done`; see section 19 and `docs/specs/feature-register.md` for
  what a row needs), and the Phase 1 gate record.

Lane A owns migrations. If an item needs a table or column, build the parts that do not, say what
migration is needed in your report, and the coordinator sequences it.

Security: MFA for every role reading care records; step-up for export and break-glass; NCSC
password rules; session cookies per ADR-0030. Every permission change, login and session revoke
is audited.

## Your first PR now: the OpenFeature provider and admin session controls

Branch `feat/platform-flags-and-sessions`:

1. An OpenFeature server provider in `apps/api` that evaluates the existing catalogue and the
   `feature_flag` overrides (tenant, then location) exactly as `/v1/me` does today, with a
   Flagsmith provider used only when its key is configured (`.env.example` entry, never a real
   key), falling back to the catalogue default when Flagsmith is unreachable. AI flags can never
   evaluate on unless the tenant override says so. Tests for the evaluation order and the
   fallback. Check the OpenFeature SDK's licence is on the allowlist.
2. Admin session revoke and idle timeouts per role, if they need no migration: an endpoint for a
   holder of the relevant platform permission to sign out another member's sessions (audited,
   step-up), and an idle timeout per role from configuration or the rate/config tables (not a
   literal in code). If either needs a schema change, leave it out and report it.

Keep it under about 600 changed lines; drop item 2 to the next PR if needed.
