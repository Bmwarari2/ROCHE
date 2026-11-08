/**
 * Retention registry: the operations context (retention sweeps plan, slice 3). Nightly downtime
 * packs are kept briefly (downtime_pack); an outage, the evidence for every back-entry's late time,
 * from its reconciliation (downtime_record).
 */

import { classes, col, entry, NO_SUBJECT, person, type RegistryContext } from "./registry";

export const OPERATIONS_REGISTRY: RegistryContext = {
  context: "operations",
  entries: [
    entry(
      "downtime_pack",
      classes("downtime_pack"),
      { createdAt: col("generated_at") },
      person("person_ids"),
      {
        note: "A pack in force during a declared outage is kept as downtime_record instead (the sweep checks outages first)",
      },
    ),
    entry("outage", classes("downtime_record"), { closedAt: col("reconciled_at") }, NO_SUBJECT),
  ],
};
