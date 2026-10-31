# Mobile release: distribution and phased rollout (MOB-012)

How the Harbour app (`apps/mobile`) reaches devices: the public listing or a private build for a
large tenant with MDM, and the phased rollout every store release follows. Master prompt 17.3 and
section 7 (two-week train). The store privacy answers are in
[app-store-privacy.md](../compliance/app-store-privacy.md); check them before every submission.

## 1. Choosing public or private distribution

| | Public listing (default) | Private distribution |
| --- | --- | --- |
| Who can install | Anyone can find it; only staff with an account can sign in | Only devices of the tenant that bought it, pushed by its MDM |
| Apple | App Store listing | Custom App through Apple Business Manager, assigned to the tenant's organisation id |
| Google | Public Play listing | Managed Google Play private app, published to the tenant's enterprise id |
| App id | `uk.co.thapsus.harbour` | A separate app id per tenant or per private build (for example `uk.co.thapsus.harbour.<tenant>`) |
| Review | Full store review | Apple still reviews a Custom App; Google reviews a private app lightly |
| Kiosk mode | Possible with MDM | The usual route: Android Enterprise dedicated device or iOS Single App Mode |

**The choice is permanent for an app id.** Apple and Google do not let a private app become public
later (master prompt 17.3; Appendix default "public listing, with a private build offered to large
tenants as a separate app ID"). So:

1. The public app stays public. A tenant that wants private distribution gets a **new app id**; it
   never moves the public one.
2. Before the first private submission, record the decision in the tenant's onboarding notes and as
   an ADR naming the tenant, the app id and the MDM (H-567). The tenant's MDM administrator gives
   their Apple Business Manager organisation id or Managed Google Play enterprise id.
3. A private build is the same code and the same privacy answers. Only the app id, display name (if
   the tenant asks) and distribution change: add an EAS profile `production-private-<tenant>` that
   extends `production`, sets the app id through `HARBOUR_APP_ID` (an app config change, not yet
   built: until then a private build is a manual branch of `app.config.ts`), and keeps
   `distribution: store`.

## 2. Every release (two-week train)

1. **Release candidate**: CI's `EAS build` job builds both platforms with the `production` profile
   and submits to TestFlight and Google Play internal testing (`.github/workflows/mobile.yml`; it
   runs only with `EXPO_TOKEN`; a `store-release` environment guard is being added to that job on
   another branch).
2. **Before submitting for review**, the release owner checks:
   - `pnpm --filter @harbour/mobile test` passes, including
     `src/config/store-compliance.test.ts` (privacy manifest, Android API 36, Xcode 26 image).
   - The privacy answers in [app-store-privacy.md](../compliance/app-store-privacy.md) still match;
     if the test changed this train, update both stores' answers first.
   - Any permission, SDK or native module change ships as a new binary, never as an over-the-air
     update (EAS Update is not installed; if it is added, it may carry JavaScript and asset fixes
     only).
   - The demo account for App Review works (H-565) and the review notes are current.
   - The Maestro flows passed on the release candidate.
3. **Submit for review** with the release notes from the `release` skill.
4. **Phased rollout** once approved:

| Step | Apple (App Store Connect) | Google (Play Console) | Move on when |
| --- | --- | --- | --- |
| 1 | Release with "Phased release for automatic updates" on (Apple's own 7-day schedule: 1%, 2%, 5%, 10%, 20%, 50%, 100%) | Staged rollout at **10%** | Crash-free sessions above 99.5% and no new clinical or sync incident for 48 hours |
| 2 | Let the schedule continue; pause if a threshold is missed | Increase to **50%** | The same, for another 48 hours |
| 3 | Completes at 100% | Increase to **100%** | |

   Apple's phased release only applies to automatic updates and follows Apple's percentages; a
   person can always update by hand. The master prompt's 10%, 50%, 100% is followed exactly on
   Google and approximately on Apple.

5. **Crash-free sessions** come from App Store Connect (Metrics) and Play Console (Android vitals):
   the app ships no crash reporter of its own (see the privacy answers). Read both at each step.

## 3. Stopping a release

- **Halt** the rollout (Play Console "Halt rollout"; App Store Connect "Pause phased release") as
  soon as a clinical safety issue, data loss on the device, a sync fault or a crash-free rate below
  99.5% is seen. Raise an incident ([incident-response.md](incident-response.md)).
- Fix forward with a new build: stores do not roll back a version. Devices already updated keep the
  new version until the fix arrives. Offline entries are kept on the device across updates
  (`runtimeVersion` policy `fingerprint`; mobile tolerates one schema version behind).
- Private builds follow the same steps; the tenant's MDM administrator can also hold the update.

## 4. Human actions

| # | Action |
| --- | --- |
| H-560 | Enter the App Privacy answers in App Store Connect from app-store-privacy.md section 2 |
| H-561 | Complete Google Play's Data safety form and Health apps declaration (sections 3 and 4) |
| H-562 | Publish Thapsus's app privacy notice and give its URL to both stores |
| H-563 | Confirm the EAS image name carrying Xcode 26 and the iOS 26 SDK and pin it in `eas.json` |
| H-564 | Publish the account deletion web page and give its URL to Google Play |
| H-565 | Create the App Review and Play review demo account (invented data) and write the review notes |
| H-566 | Decide and build how a manager suspends or removes a member and erases their sign-in |
| H-567 | Record each private distribution decision (tenant, app id, MDM) as an ADR before first submission |
| H-568 | Set the phased rollout and crash-free threshold alerts in App Store Connect and Play Console |
| H-569 | Choose the store categories and write the listing text, including "Harbour is not a medical device" |

See [human-actions.md](../plans/human-actions.md) for owners and status.
