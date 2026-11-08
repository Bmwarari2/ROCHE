# The API's medicines competence port reads the workforce sign-offs (H-1532)

Branch `feat/medicines-competence-port`, from main. No migration.

- `workforceCompetence` (apps/api/src/integrations/medicines-ports.ts): in production the medicines
  module's competence port judges the member's `medicines_administration` sign-offs and
  withdrawals with `competenceDecision`, through the workforce competence port with the system's
  rights, instead of answering `not_held` for everyone. The server's clock decides; a claimed time
  can only block. A withdrawal leaves `not_held`, which no override clears. Overrides have no
  workforce record yet, so none is in force.
- Development and tests keep the fixed demo map; #208's demo seed gives the same members matching
  sign-offs, so the phone, which judges the same rows, agrees.
- Tests: `hazard HZ-119 medicines reads competence from the workforce sign-offs (H-1532)` in
  apps/api/test/training-competence.test.ts. Hazard log HZ-119.
- H-1531 (a server record when a phone's key stops opening its database) follows in its own pull
  request: it needs a discard kind and a reason no member chooses, and a migration.
