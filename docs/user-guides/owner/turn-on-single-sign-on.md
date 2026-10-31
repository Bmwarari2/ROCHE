# How to turn on single sign-on

Single sign-on lets your staff sign in to Harbour with your organisation's own work account (an
OpenID Connect identity provider). It is off for every organisation, and there is no screen for it
yet.

**Who can do this**: only the owner can see or change your organisation's single sign-on settings,
and every change needs you to confirm it is you with your passkey or authenticator app (step-up).
Turning the feature on for your organisation is done by Thapsus, not by you.

**Register row**: PLAT-005.

## Steps

There are no steps in Harbour yet: single sign-on has an API but no web screen on `main`, and no
sign-in button for it.

1. Ask Harbour support whether single sign-on can be turned on for your organisation. It stays off
   until Thapsus has finished its security review.
2. Have ready, from whoever runs your identity provider: its issuer and discovery address (https),
   the client id Harbour is registered under, and which Harbour roles may use single sign-on.
3. Harbour support tells you how to prove that you own your email domain, with a DNS record. A
   domain counts only once it is proved.

## Good to know

- **Single sign-on never stands in for Harbour's second factor.** It replaces your password only.
  Before anyone opens care records, or does anything that needs step-up, Harbour still asks for
  their passkey or authenticator code. Harbour ignores what your identity provider says about its
  own second factor.
- **It never creates anyone.** Only people already invited to, or already working in, your
  organisation can use it, at an email domain you have proved. Invite people first, as in
  [How to invite a team member](../registered-manager/invite-a-team-member.md).
- Family members and Thapsus staff never sign in with it.
- People whose role is not on your allowed list sign in with Harbour's own methods, as now.
- No password or secret for your identity provider is ever kept in Harbour; only the name of a key
  held in a secure store.
- If single sign-on is turned off again, everyone signed in with it is signed out at once and signs
  in with Harbour's own methods.
- Changing the identity provider's issuer, client or discovery address turns single sign-on off
  until every domain is proved again.
- The rules are in the
  [platform specification](../../specs/platform.md#phase-2-single-sign-on-plat-005),
  [ADR-0091](../../decisions/0091-single-sign-on.md) and the hazard log,
  [HZ-112](../../clinical-safety/hazard-log.md#hz-112-care-records-opened-without-a-second-factor-or-staff-shut-out-of-them-when-the-rule-tightens).
  Signing in is described in [How to sign in](../all-staff/sign-in.md).
