# Shared and kiosk devices

| Item | Value |
| --- | --- |
| Source requirement | Master prompt 5.3 (authentication) and 17.2 (device policy, kiosk configuration) |
| Related hazards | HZ-001 (wrong person), HZ-010 (clock drift), HZ-011 (out-of-scope exposure) in the [hazard log](../clinical-safety/hazard-log.md) |
| Status | Design, Phase 0. Kiosk configuration ships with Care mode in Phase 1 |
| Owner | Engineering lead; reviewed by the `security-reviewer` and `accessibility-reviewer` agents |

## 1. Why shared devices need their own rules

Care homes use shared tablets on a unit or corridor, and night staff often share a device. Full passkey or password sign-in plus MFA for every short interaction would push staff to leave devices signed in or to record later from memory, both of which are worse for safety and for the record. The design below keeps two factors for every sign-in while making a switch of user take a few seconds.

## 2. Device modes

| Mode | Device | Sign-in | Auto-lock |
| --- | --- | --- | --- |
| Personal | A user's own or assigned phone | Full sign-in (passkey, or password plus TOTP) once; then biometric (`BIOMETRIC_STRONG`) or PIN to unlock | 2 minutes idle |
| Shared | Tenant-owned, MDM-enrolled phone or tablet used by several staff | User picker (photos) then PIN; possession factor is the enrolled device | 30 seconds idle by default, tenant-configurable from 30 seconds to 2 minutes |
| Kiosk | Shared device locked to Harbour: Android Enterprise dedicated-device mode or iOS Single App Mode, configured by the tenant's MDM | As shared | As shared |

## 3. Controls

### 3.1 Authentication

| Control | Detail |
| --- | --- |
| Possession factor: the MDM-enrolled device | A manager enrols the device in Harbour (Settings, Devices) with an enrolment token delivered through the MDM's managed app configuration. The app generates a non-exportable key pair in the Android Keystore or iOS Secure Enclave; Harbour registers the public key against the tenant and location. Every sign-in signs a server challenge (online) or a locally verifiable assertion (offline) with this key. A device that is not enrolled cannot use shared mode |
| Knowledge factor: the user's PIN | Personal to the user, set during a full sign-in on a personal device or a supervised first sign-in; at least 6 digits; trivial PINs (repeated or sequential digits) refused |
| Identification aid: the user's photo | The picker shows the photo and name of staff rostered or assigned at this location, so a user cannot pick a colleague's tile by mistake. The photo is not an authentication factor |
| Biometrics | Platform biometrics on iOS and Android confirm only that some biometric enrolled on the device matched, not which person. On a shared device they cannot tell users apart, so they are **not accepted as the user factor in shared or kiosk mode**. See section 5 |
| MFA policy | Enrolled device plus PIN is two factors (possession and knowledge), consistent with NCSC guidance on MFA; a full sign-in with passkey or TOTP is still required on a personal device at enrolment of the PIN |
| PIN throttling | Increasing delay after failed attempts; after 10 failures the user must re-establish their PIN through a full sign-in. Throttling, not lockout of the device, so that other staff can still sign in |
| Offline sign-in | The PIN check works offline: the user's session key is wrapped with a key derived from the PIN and a device-bound Keystore key, so a guess requires the device's secure hardware and is throttled by the app |
| Step-up | Controlled-drug entries require a second user (witness) to sign in with their own PIN on the same device; data export and break-glass are not available on shared devices |

### 3.2 Session and locking

| Control | Detail |
| --- | --- |
| Auto-lock | 30 seconds idle by default; the tenant may set 30 seconds to 2 minutes per location or device group. Lock returns to the user picker, never to the previous person's record |
| Work in progress | Unsaved input is kept as an encrypted draft for that user only and restored after they sign in again; it is never shown to another user |
| Auto sign-out at shift end | Sessions end at the user's shift end from the rota (Phase 2); until rota ships, at the end of the location's configured shift pattern. Agency and bank workers end at shift end plus 2 hours (master prompt 4) |
| One user at a time | Signing in a second user ends the first user's session on that device; per-user sessions keep each user's queued changes attributed to them |
| Lock-screen content | Push notifications on shared devices show no personal data and no person names |

### 3.3 Device policy (deployer controls, set in the tenant's MDM)

| Control | Why |
| --- | --- |
| Device enrolled and supervised (iOS) or fully managed / dedicated (Android) | Possession factor; remote wipe; app lock-down |
| Device passcode set, automatic date and time on, OS updates applied | SQLCipher key protection; HZ-010; patching |
| USB debugging and developer options off; no other apps; no app installs | Reduces tampering and data exfiltration |
| Lost-device process: report in Harbour, MDM wipe, Harbour revokes the device key | Data on a lost device cannot be used |
| Devices stored on charge in a staff-only area when not in use | Physical security |

### 3.4 Compensating controls

| Control | Detail |
| --- | --- |
| Reduced function | Shared mode offers point-of-care work only (notes, charts, tasks, eMAR, incidents). No data export, break-glass, finance, HR or user administration |
| Scoped data | The device holds data only for its location's assigned people and the next 7 days; reference data for assigned people is never evicted while assignments stand |
| Attribution and audit | Every sign-in, lock, sign-out and record is audited with user, device ID and location; managers see sign-ins per device |
| Anomaly checks | The same user active on two shared devices at once, or a sign-in outside rostered hours, is flagged to the manager |
| Remote revocation | Revoking a device key stops sign-ins at the next online check; the device wipes its local store when told to |
| Root and jailbreak detection | Warns, and blocks eMAR |
| Screen privacy | Screenshots blocked on record screens; clipboard disabled for identifiers |
| Accessibility | The PIN pad supports VoiceOver and TalkBack, large targets and no time limit while entering the PIN. An alternative to remembering a PIN is needed for WCAG 2.2 criterion 3.3.8 (section 5) |

### 3.5 Exception: the cached downtime pack

A kiosk at a location keeps the latest downtime pack ([operations.md](../specs/operations.md)
rule 8, OPS-028) so that staff can print it when the network or Harbour is down. The pack covers
every person at the location, which is wider than the scoped data in section 3.4, and printing it is
a form of export, which section 3.4 otherwise keeps off shared devices. The exception is accepted
because the pack is the continuity path for safe care in an outage (hazard HZ-021), with these
controls (`packages/domain/src/operations/kiosk-cache.ts`):

| Control | Detail |
| --- | --- |
| Encrypted at rest under its own key | The pack (JSON and PDF) is stored encrypted inside the SQLCipher store under a separate key held in the Keystore or Secure Enclave. The device releases that key only to a PIN session (section 3.1) of a user who holds `operations.downtime.read` (`kioskDowntimePackUnlock`); anyone else is told to ask the nurse or senior in charge |
| Print only | The cached pack can be printed or viewed; it cannot be shared, saved to files, copied or sent from the device. Screenshots stay blocked |
| Audit while offline | Every open and every print is queued on the device as an audit event with opaque ids only (pack, user, device, time) and uploaded when the device is next online (`kioskPrintAuditEvent`) |
| Eviction | The cached pack is deleted when the device key is revoked (section 3.4, remote revocation) and once its `downtime_pack` retention period ends (`kioskDowntimeCacheDisposition`); a newer pack replaces it |
| Freshness on every page | Each print recomputes the page header from the device clock: current, out of date, outage or clock behind (operations.md rule 2) |

## 4. Residual risks

| Risk | Mitigation in place | Residual assessment |
| --- | --- | --- |
| Someone uses the device in the seconds before auto-lock after the user walks away | 30-second default lock; attribution audit; staff training | Accepted; tenant may not lengthen beyond 2 minutes |
| PIN seen by a colleague (shoulder surfing) or shared deliberately | PIN personal; anomaly checks; policy and training that sharing a PIN is a disciplinary matter | Accepted with deployer control (tenant policy) |
| Stolen device with offline data | SQLCipher encryption; non-exportable keys; MDM wipe; device revocation | Low |
| Offline PIN guessing on a compromised device | PIN-derived key combined with a hardware-bound key; app throttling | Low; depends on the integrity of the device's secure hardware |
| Staff photos and names visible on the picker | Picker limited to staff rostered or assigned at the location | Accepted; staff privacy notice explains it |
| A user unable to remember a PIN (cognitive disability) | See section 5 | Open until an alternative ships |

## 5. Decisions needing an ADR

1. **Biometrics on shared devices.** The master prompt allows "PIN or biometric plus the user's photo" on shared devices. Platform biometrics cannot identify which of several users matched, so this document permits PIN only on shared devices. Proposed alternative second factor: a per-user NFC badge or FIDO2 security key, which also gives an accessible alternative to a PIN for WCAG 2.2 criterion 3.3.8. Record the decision in an ADR `[engineering decision]`.
2. **Database key on shared devices.** On personal devices the SQLCipher key is held with `requireAuthentication` (device-owner authentication). A shared device has no single owner, so the key is held non-exportable and device-bound without per-access owner authentication, and record access is gated by the per-user session. Record in the same ADR.
3. **Shift-end sign-out before the rota exists.** Use the location's configured shift pattern until Phase 2.
