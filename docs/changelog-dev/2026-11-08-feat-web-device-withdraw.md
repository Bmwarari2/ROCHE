# Managers withdraw a lost phone on the web (MOB-010)

Branch `feat/web-device-withdraw`, from main. No migration and no API change: the screens use
`GET /v1/devices` and `POST /v1/devices/{deviceId}/revoke`.

- **Care mode phones** (`/settings/devices`) lists each phone staff have used:
  - who used it and when it was last seen;
  - the entries it last reported waiting, with the time of that report;
  - whether it is in use or withdrawn, as an icon and a word.
  It is shown in the menu to holders of `platform.device.read`.
- A phone's page (`/settings/devices/{deviceId}`) has the withdraw form, for holders of
  `platform.device.revoke`:
  - a coded reason;
  - the second sign-in step;
  - a tick confirming that withdrawing cannot be undone and what happens to any entries waiting.
    The API's own `entries_waiting` refusal asks to reload and tick again.
  - After a withdrawal the page opens again and says so, with focus on its heading.
- Code: `lib/care-devices.ts` (grouping and permissions, tested), the `withdrawDevice` action,
  `DeviceWithdrawForm` and `DeviceStateChip`.
- Strings: new `devices.*` strings and `shell.nav.devices` in en-GB. Welsh is marked untranslated.
- User guides: the new [How to withdraw a lost or unused phone](../user-guides/registered-manager/withdraw-a-lost-phone.md).
  The lost or stolen phone guide no longer says there is no screen.
- Hazard log: HZ-006.
- Accessibility review, folded in:
  - the `entries_waiting` refusal is kept and tied to the box;
  - success is announced after the page reloads;
  - a title per phone;
  - names joined as a list in words;
  - dates in `<time>` elements;
  - a short id that never clashes;
  - the busy state is said;
  - copy and guide alignment.
- Playwright: `e2e/care-devices.spec.ts` (manager list with axe in light and dark, 404 for an
  unknown phone, care worker refused). It has not been run here. The withdraw form itself needs a
  synced phone, which the demo seed does not give.
