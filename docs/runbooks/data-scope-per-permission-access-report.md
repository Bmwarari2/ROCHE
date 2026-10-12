# Pre-deployment access report: data scope per permission

Before deploying data scope per permission ([ADR-0071](../decisions/0071-data-scope-is-per-permission.md);
hazards HZ-011 and HZ-073) to an organisation with real staff, list whose reach changes, so the
Registered Manager can fix role bundles and grants first. It is a deployer control in the
[DCB0160 template](../clinical-safety/dcb0160-deployment-template.md) (HZ-011 and HZ-073 rows) and
part of H-169.

## What it shows

For each member of staff, one row for each of four reads whose reach changes:

| Read | What it opens |
| --- | --- |
| `people.person.read` | The person's record on screen |
| `sync: people` | The person and allergies on a phone: needs `people.person.read` and `care.plan.read`, and syncs where both reach, so the phone never shows a resuscitation decision or IDDSI level as not recorded when it is merely absent (review round 2) |
| `sync: care` | The care reference and active plan details on a phone (`care.plan.read`) |
| `sync: entries` | Recent notes, charts and body map marks on a phone (`care.note.read`) |

| Column | Meaning |
| --- | --- |
| `change` | `narrows` (the member reaches fewer people) or `widens` (more); one member can have both |
| `tenant_user_id` | The member (an opaque id; look them up in the organisation's team screen) |
| `read` | One of the four reads above |
| `before` | The old reach: one merged scope from all the member's roles, used for every permission they held. A role scoped to the organisation or to a location reached its location when assigned at one and everywhere when assigned with none. Grants added permissions but no reach. A phone synced every family wherever the merged scope reached, and the people the member was assigned to, for anyone holding `people.person.read` |
| `after` | The new reach: only the roles and grants carrying that read, and the people the member is assigned to only through a role scoped to assigned people that carries it |
| `detail` | What is lost or gained: the whole organisation, named homes, or a count of the people the member is assigned to (never named) |

Typical rows:

- **Narrows**: a care worker who also holds a role scoped to the organisation or a home for
  something unrelated (a custom dashboards role, say) now reaches only the people they are
  assigned to; a care
  coordinator, who holds `people.person.read` and `care.plan.read` but not `care.note.read`, no
  longer syncs recent entries (`sync: entries`, after "no one"), though their phone still holds
  the people and their care reference.
- **Widens**: a grant at a home the member's roles do not reach now opens that home for the
  grant's permissions (before, the grant's permissions applied only where the roles reached); a
  member with grants and no role now reaches the grant's home. A grant with no location reads as
  "gains the whole organisation (through a grant with no location)": before the change it applied
  wherever the member's roles reached, so migration 0048 stops on a live one rather than widen it
  (below).

## How to run it

1. **Every device syncs first.** A device that narrows keeps no records it can no longer open, and
   nothing written under the old scope waits on it. Announce a cut-off time, then check:
   - on each phone in Care mode, Today's sync status shows a last sync after the cut-off, "No
     changes waiting to upload", and no entries needing attention or held;
   - centrally, the device list (`GET /v1/devices`, `platform.device.read`; Registered Manager,
     deputy or owner) shows each device's last seen time after the cut-off and its last reported
     waiting count (`entriesWaiting`) at 0. A device not seen since the cut-off is found and
     synced, or revoked (`staff_left`, `replaced` or `lost_or_stolen`) once any entries it reported
     waiting are resolved. As `harbour_owner`, read-only, the devices not seen since the cut-off are:

     ```sql
     BEGIN READ ONLY;
     SELECT set_config('app.tenant_id', '<organisation uuid>', true),
            set_config('app.scope', 'tenant', true);
     SELECT device_id, max(last_seen_at) AS last_seen
     FROM device_binding
     WHERE tenant_id = '<organisation uuid>' AND revoked_at IS NULL
     GROUP BY device_id
     HAVING max(last_seen_at) < '<cut-off, UTC>';
     ROLLBACK;
     ```

2. **Run the report** read-only, as `harbour_owner`, once per organisation, before migrations 0048
   and 0049 (it also runs after them):

   ```sh
   psql "$OWNER_DATABASE_URL" -v tenant_id=<organisation uuid> \
     -f docs/runbooks/data-scope-per-permission-access-report.sql
   ```

   The script opens a `READ ONLY` transaction, filters every table by the organisation as well as
   through row-level security, and ends with `ROLLBACK`. It writes nothing.
3. **Narrows**: give the rows to the Registered Manager. For each member who must still act on
   safety work where the report says they no longer reach (a nurse covering another home, a senior
   carer on a different unit), add a role assignment at that home: cover at another home is a role
   assignment there until grants can be managed in the product.
4. **Widens**: check each row is intended. A grant that now opens a home the member does not
   work at is ended or narrowed. **A grant with no location stops the deployment**: migration 0048
   raises `Data scope per permission: N live access grant(s) have no location` (a check violation,
   so nothing is changed) while any grant with no location is live (not deleted, not revoked, not
   yet ended), because marking it organisation-wide would widen it and nothing can mark it
   narrower. For each, end it, or replace it with a grant at the home it was meant for, then deploy
   again. Ended, revoked or deleted ones reach no one and are marked without stopping.
5. Run the report again until the remaining rows are the change the organisation intends, and
   record the review in the organisation's DCB0160 assessment (HZ-011 and HZ-073 rows).

The report holds staff ids, location names and counts only, never people receiving care. Keep the
output with the deployment record, not in a ticket or chat.
