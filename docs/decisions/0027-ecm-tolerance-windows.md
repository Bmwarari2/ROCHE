---
status: accepted
date: 2026-10-11
decision-makers: Claude Code (lead engineer); Brian may supersede
consulted: master prompt section 13.2; docs/specs/rates.md
informed: everyone working on domiciliary scheduling
---

# Electronic call monitoring tolerance windows by risk

## Context and problem statement

Section 13.2 sets default visit tolerance windows of 15, 30 and 60 minutes "configurable per client
risk" without saying which risk level gets which.

## Decision outcome

High risk 15 minutes, medium 30, low 60 (`ecm.tolerance_minutes.high|medium|low` in the rate table):
a late visit to the person at greatest risk raises the alarm soonest. Tenants override per contract or
per client. Recorded as a product default, not a statutory figure.
