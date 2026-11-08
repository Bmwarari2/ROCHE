/**
 * The retention registry (retention sweeps plan, section 5.3): every table that holds personal
 * data, one file per bounded context, and the tables known to hold none.
 */

import { CARE_REGISTRY } from "./care";
import { COMMS_REGISTRY } from "./comms";
import { INTEGRATIONS_REGISTRY } from "./integrations";
import { MEDICINES_REGISTRY } from "./medicines";
import { OPERATIONS_REGISTRY } from "./operations";
import { PEOPLE_REGISTRY } from "./people";
import { PLATFORM_REGISTRY } from "./platform";
import { QUALITY_REGISTRY } from "./quality";
import type { RegistryContext, RetentionTableEntry } from "./registry";
import { SAFETY_REGISTRY } from "./safety";
import { SCHEDULING_REGISTRY } from "./scheduling";
import { WORKFORCE_REGISTRY } from "./workforce";

export { NO_PERSONAL_DATA } from "./no-personal-data";
export {
  type ClassList,
  type ColumnReference,
  catalogueRetentionFor,
  columnReferences,
  type DateSource,
  type DestructionMethod,
  entryClasses,
  factsNeeded,
  type NoPersonalDataTable,
  PERIOD_END_CLASSES,
  type RegistryContext,
  type RegistryRetention,
  type RetentionSubject,
  type RetentionTableEntry,
  registryProblems,
  SUBJECT_KINDS,
  type SubjectKind,
  type TriggerSources,
} from "./registry";

/** Every context's entries, in the order of the bounded contexts that hold them. */
export const RETENTION_REGISTRY_CONTEXTS: readonly RegistryContext[] = [
  PLATFORM_REGISTRY,
  PEOPLE_REGISTRY,
  CARE_REGISTRY,
  MEDICINES_REGISTRY,
  SAFETY_REGISTRY,
  QUALITY_REGISTRY,
  WORKFORCE_REGISTRY,
  SCHEDULING_REGISTRY,
  OPERATIONS_REGISTRY,
  COMMS_REGISTRY,
  INTEGRATIONS_REGISTRY,
];

export const RETENTION_REGISTRY: readonly RetentionTableEntry[] =
  RETENTION_REGISTRY_CONTEXTS.flatMap((c) => c.entries);

/** The entry for a table (bare name in `public`, or `auth.<name>`), if it has one. */
export function retentionEntry(table: string): RetentionTableEntry | undefined {
  return RETENTION_REGISTRY.find((e) => e.table === table);
}
