# Pre-deployment access report: data scope per permission

Before deploying data scope per permission ([ADR-0071](../decisions/0071-data-scope-is-per-permission.md);
hazards HZ-011 and HZ-073) to an organisation with real staff, list who will reach fewer people, so
the Registered Manager can fix role bundles first. It is a deployer control in the
[DCB0160 template](../clinical-safety/dcb0160-deployment-template.md) (HZ-011 row) and part of
H-169.

## What it shows

For each member of staff, and for `people.person.read` and the three reads the sync streams serve
(`people.person.read` for the person and allergies, `care.plan.read` for the care reference and
plan details, `care.note.read` for recent entries), one row when the reach narrows:

| Column | Meaning |
| --- | --- |
| `tenant_user_id` | The member (an opaque id; look them up in the organisation's team screen) |
| `permission` | The read |
| `before` | The old merged reach: the widest scope of all their roles, with the people they are assigned to counted for every permission |
| `after` | The new reach: only the roles and grants carrying that permission, assigned people only when a role scoped to them carries it |
| `narrows` | What is lost: the whole organisation, named homes, or assigned people |

Typical rows: a care worker who also holds an organisation-wide role for something else (finance,
quality) now reaches only the people they are assigned to; someone covering another home through
a grant now reaches that home only for the grant's permissions; a coordinator, who holds no
`care.note.read`, syncs no recent entries.

## How to run it

1. Every device in Care mode syncs before the deployment (each is on the network with nothing
   queued): a device that narrows keeps no records it can no longer open, and nothing written
   under the old scope waits on it.
2. Run the report read-only, as `harbour_owner`, once per organisation, before migrations 0048 and
   0049 (it also runs after them):

   ```sh
   psql "$OWNER_DATABASE_URL" -v tenant_id=<organisation uuid> \
     -f docs/runbooks/data-scope-per-permission-access-report.sql
   ```

   The script opens a `READ ONLY` transaction, filters every table by the organisation as well as
   through row-level security, and ends with `ROLLBACK`. It writes nothing.
3. Give the rows to the Registered Manager. For each member who must still act on safety work
   where the report says they no longer reach (a nurse covering another home, a senior carer on a
   different unit), add a role assignment at that home: cover at another home is a role
   assignment there until grants can be managed in the product.
4. Run it again until the remaining rows are the narrowing the organisation intends, and record
   the review in the organisation's DCB0160 assessment (HZ-011 row).

The report holds staff ids and location names only, never people receiving care. Keep the output
with the deployment record, not in a ticket or chat.
