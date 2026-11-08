# The API's medicines competence port reads the workforce sign-offs (H-1532)

Branch `feat/medicines-competence-port`, from main. No migration.

- `workforceCompetence` (apps/api/src/integrations/medicines-ports.ts): in production the medicines
  module's competence port judges the member's `medicines_administration` sign-offs and
  withdrawals with `competenceDecision`, through the workforce competence port with the system's
  rights, instead of answering `not_held` for everyone. A withdrawal leaves `not_held`, which no
  override clears. Overrides have no
  workforce record yet, so none is in force.
- After the clinical review: inside a request's transaction the port reads on that transaction
  (never a second connection while the person's lock is held); a record is judged on the day of
  the event it records, never later than today, so an offline dose given while competent is not
  refused after a lapse; a route-level test records a dose through the real port. H-1533 (CSO):
  specialist competences, withdrawn never overridden, past-event rule, go-live readiness.
- Development and tests keep the fixed demo map; #208's demo seed gives the same members matching
  sign-offs, so the phone, which judges the same rows, agrees.
- Tests: `hazard HZ-119 medicines reads competence from the workforce sign-offs (H-1532)` in
  apps/api/test/training-competence.test.ts. Hazard log HZ-119.
- H-1531 (a server record when a phone's key stops opening its database) follows in its own pull
  request: it needs a discard kind and a reason no member chooses, and a migration.
