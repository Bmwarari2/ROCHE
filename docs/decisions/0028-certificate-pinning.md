---
status: proposed
date: 2026-10-11
decision-makers: open
consulted: OWASP MASVS L2 (MASVS-NETWORK-2); docs/compliance/security-checklist.md
informed: everyone working on the mobile app
---

# Certificate pinning in the mobile app

## Context and problem statement

MASVS Level 2 expects the app to pin the API's certificate or public key. Pinning a single leaf
certificate bricks installed apps when the certificate rotates, and AWS-managed certificates rotate.

## Considered options

1. Pin the public keys of the issuing intermediate CAs (Amazon RSA and ECDSA roots/intermediates) with
   a backup set, rotated through app releases.
2. Pin our own keys behind a long-lived private CA on the load balancer.
3. No pinning; rely on platform trust stores and short-lived tokens (does not meet MASVS L2).

## Decision outcome

Open until Phase 1 mobile hardening. Recommendation: option 1, with the pin set shipped in the binary
and a kill switch through remote config to fall back if a pin set becomes invalid. Logged as an
engineering follow-up in docs/plans/STATUS.md.
