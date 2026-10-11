---
status: accepted
date: 2026-10-11
decision-makers: Brian (Thapsus Cargo Ltd, Appendix default); recorded by Claude Code
---

# AI model provider: Amazon Bedrock London by default, Claude optional per tenant

## Context and problem statement

The AI Management Copilot (section 16) is optional and off by default. When a tenant enables it, which
model provider and residency stance applies?

## Decision drivers

- Personal data stays in the UK by default; any inference outside the UK must be disclosed in the
  sub-processor register and DPIA.
- No provider may train on tenant data; zero data retention where available.
- Tenants differ in appetite: some will accept EU-geo inference for a stronger model, some will not.
- The gateway must keep providers swappable and fully audited.

## Considered options

- Bedrock in-Region London models only.
- Claude via Bedrock EU-geo cross-region inference.
- Anthropic API with zero data retention under a signed agreement.
- Tenant bring-your-own key.

## Decision outcome

Chosen option: "Bedrock in-Region London models by default; Claude optional per tenant (Bedrock EU-geo
or the Anthropic API with zero data retention) with DPIA wording; tenant BYO key allowed", because it
is the Appendix default.

### Consequences

- Good, because the default keeps inference in London and the stronger option is a per-tenant,
  documented choice.
- Bad, because in-Region London model choice may be narrower than EU-geo; quality is measured by the
  evaluation suite per provider.
- The AI gateway is the only code path allowed to call a model; every adapter has a contract test;
  pseudonymisation, scope lock, audit (12 months) and the kill switch apply to every provider
  (section 16.2).
- Enabling Claude for a tenant requires the AI addendum to the DPIA naming the geography, and an entry
  in that tenant's sub-processor register.

## More information

- Takes effect: Phase 6.
- To verify before Phase 6 (section 21 open item): whether the Bedrock EU geography includes London,
  and the current list of in-Region London models.
- Human action: a tenant's DPO approves the DPIA AI addendum before the module is switched on.
- How to change: supersede this ADR (for example to make Claude the default for all tenants).
