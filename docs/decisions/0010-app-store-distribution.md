---
status: accepted
date: 2026-10-11
decision-makers: Brian (Thapsus Cargo Ltd, Appendix default); recorded by Claude Code
---

# App store distribution: public listing, with a private build as a separate app ID

## Context and problem statement

The Expo app ships to the App Store and Google Play. Distribution can be a public listing or private
enterprise distribution (Apple Custom Apps through Apple Business Manager; Managed Google Play private
apps). The choice is irreversible per app: a private app cannot later become public.

## Decision drivers

- Most providers have no mobile device management (MDM) and need to install from the public stores.
- Large tenants with MDM may not want a public listing.
- Irreversible decisions take the Appendix default and an ADR (section 20, item 8).

## Considered options

- Public listing only.
- Private distribution only.
- Public listing as the default app, plus a private build under a separate app ID for large tenants.

## Decision outcome

Chosen option: "Public listing, with a private build offered to large tenants as a separate app ID",
because it is the Appendix default and keeps both routes open without risking the irreversible switch
on the main app.

### Consequences

- Good, because small providers install from the stores and large tenants with MDM get a private app.
- Bad, because a private build is a second binary to sign, review and support; EAS build profiles and
  app config keep the two in step from one codebase.
- Publisher is Thapsus Cargo Ltd on both stores (Apple requires a legal entity for healthcare apps).
- Store compliance (privacy labels, health declarations, account deletion, required SDK levels) applies
  to both binaries (section 17.3).

## More information

- Takes effect: Phase 1 (first store submission).
- Human actions: Apple Developer Program and Google Play Console accounts (ADR-0020); Apple Business
  Manager and Managed Google Play set-up for any private tenant.
- How to change: supersede this ADR before the first store approval of the affected app ID; after
  approval, a change needs a new app ID.
