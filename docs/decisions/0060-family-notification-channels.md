---
status: "accepted"
date: 2026-10-11
decision-makers: Claude Code (lead engineer)
consulted: comms.md, the integrations framework (INTG-001), records of processing
informed: Brian, the data protection lead, the CSO
---

# Family notification channels: provider-neutral ports and events, content-free messages

## Context and problem statement

The family feed (COMMS-001) tells family members who opt in that there is something new, by
email, SMS or push (INTG-011, master prompt 15.3: "SES, SMS gateway, Expo push"). Phase 0 built
the ports (`comms.email`, `comms.sms`, `comms.push` in `packages/domain/src/integrations/ports.ts`)
with SES and Expo adapters and a mock, for staff notifications. Family notifications add new
recipients outside the organisation, opt-outs (STOP replies, unsubscribe links), bounces and
complaints, and an SMS gateway that has not been chosen (H-09). How should the providers be
abstracted so that the rules, the hazard controls (HZ-060) and the tests do not depend on a
provider, and so that the SMS gateway can be chosen later without changing the domain?

## Decision drivers

- No health details or names in any message (HZ-060; master prompt 9.1: push, email and SMS
  bodies never carry personal data).
- UK residency for personal data (master prompt 6); a provider receiving family contact details
  joins the sub-processor register and the DPIA.
- The SMS gateway is undecided; build against a contract-tested mock (section 20 rule 2).
- Opt-outs must take effect at once, whichever route the family member used.
- Every integration is an adapter behind a domain interface with a mock and a contract test
  (master prompt 15.3 rules).

## Considered options

- Provider-neutral ports and channel events in the domain, with adapters translating each
  provider's messages and webhooks; messages built from an approved generic template and a link
  only.
- Provider-specific handling in the API (SES bounce and complaint notifications, Expo receipts and
  the gateway's receipts read directly by each route).
- A third-party multi-channel notification service (a communications platform or NHS Notify) that
  owns templates, preferences and opt-outs.

## Decision outcome

Chosen option: "provider-neutral ports and channel events", because it keeps the hazard controls
and opt-out rules in tested domain code, reuses the Phase 0 ports, lets the SMS gateway be chosen
later behind the existing mock, and adds no sub-processor beyond the ones the master prompt names.

- Ports stay as Phase 0 defined them: a message is an idempotency key, a title and a link. Family
  notifications put the approved template's words in the title and the portal's updates page in
  the link (`planFamilyNotification`); the planner never sees the update's content.
- Adapters translate provider reports into `FamilyChannelEvent` (permanent or temporary bounce,
  complaint, unregistered device, opt-out or opt-in with the route, verification, new address);
  `applyFamilyChannelEvent` decides what each does (`packages/domain/src/comms/channels.ts`).
  Provider webhooks are inbound integrations: validated with Zod and quarantined on failure.
- SMS replies are read only as keywords (`classifySmsReply`); replies are not a messaging channel.
- Templates come from the approved templates (COMMS-007); the planner refuses any that are not
  approved, hold a placeholder, fail the outbound guard, contain a clinical term or name the person.

### Consequences

- Good, because HZ-060 is controlled by construction and tested without any provider.
- Good, because changing or adding a provider means one adapter and the contract tests, not a
  change to rules or hazards.
- Good, because opt-outs from any route behave the same and are audited the same way.
- Bad, because each adapter must map its provider's webhook vocabulary into the events, which is
  extra code per provider and a place for mapping mistakes (covered by the contract tests).
- Neutral, because NHS Notify stays possible as another adapter if social-care eligibility is
  confirmed (master prompt 6).

### Confirmation

`packages/domain/src/comms/channels.test.ts` and `notify-plan.test.ts` (including the
`hazard HZ-060` tests); the port contract tests in `apps/api/test/adapters.test.ts`, which every
adapter (SES, Expo, the SMS mock and later the chosen gateway) must pass; code review of each new
adapter's event mapping.

## Pros and cons of the options

### Provider-neutral ports and channel events

- Good, because rules and hazard tests are independent of providers.
- Good, because it extends the Phase 0 integration framework instead of adding a second one.
- Bad, because each adapter carries a small translation layer.

### Provider-specific handling in the API

- Good, because there is less code to start with.
- Bad, because opt-out and bounce rules would be repeated per provider and untested as a whole.
- Bad, because choosing the SMS gateway later would change API routes and tests.

### A multi-channel notification service

- Good, because templates, preferences and opt-outs come ready-made.
- Bad, because it adds a sub-processor holding family contact data and template content, usually
  outside the UK, against the residency rule.
- Bad, because the hazard controls would live in a vendor's configuration rather than tested code.

## More information

[comms.md](../specs/comms.md) section 4 rules 13 to 15; [platform.md](../specs/platform.md)
integrations framework; [sub-processors.md](../compliance/sub-processors.md) pending entries;
human actions H-09 and H-105 (SMS gateway), H-106 (DPO). Revisit when the SMS gateway is chosen or
if NHS Notify becomes available to social care providers.
