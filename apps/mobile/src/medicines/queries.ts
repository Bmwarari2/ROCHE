/**
 * The phone's medicines queries (slice 69). Every query is by tenant; the streams decide which
 * rows reach the phone (ADR-0130), so these read what is here. Withdrawn versions never sync.
 */
import { MEDICINES_RATES_META_ID } from "./rates";

export const ROUND_MEDICATION_SQL = `SELECT id, person_id, medicine_id, version, replaces_id, state,
  vmp_id, amp_id, product_name, route_code, route_name, directions, pattern_kind, interval_days,
  weekdays, interval_weeks, anchor_on, day_of_month, prn_dose, prn_max_per_24h, tags,
  minimum_interval_minutes, indication, special_instructions, starts_at, stops_at, stop_at,
  stop_effective_at, cd_schedule, check_outcome, replaced_by_id, replaced_from, origin,
  corrected_part_way_through, earlier_doses_due_on, earlier_doses_due_reason
FROM medication WHERE tenant_id = ? ORDER BY person_id, product_name COLLATE NOCASE, id`;

export const ROUND_SCHEDULE_SQL = `SELECT medication_id, position, time, dose_kind, quantity,
  from_quantity, to_quantity, unit_code, unit_name
FROM medication_schedule WHERE tenant_id = ?`;

export const ROUND_ADMINISTRATIONS_SQL = `SELECT id, person_id, medication_id, due_at, outcome,
  quantity, unit_code, given_at, administered_by, supersedes_id, request
FROM medication_administration WHERE tenant_id = ?`;

export const ROUND_PEOPLE_SQL = `SELECT id, preferred_name, given_name, family_name, room_label,
  allergy_status
FROM person WHERE tenant_id = ?`;

export const MEDICINES_RATES_SQL = "SELECT value FROM sync_meta WHERE id = ?";
export const medicinesRatesParams = [MEDICINES_RATES_META_ID];

/** The device subset's packs and barcodes, for matching a scan (ADR-0130). */
export const DEVICE_GTINS_SQL =
  "SELECT gtin, ampp_id, start_date, end_date FROM dmd_device_gtin WHERE gtin = ?";
export const DEVICE_PRODUCTS_SQL =
  "SELECT id, kind, vmp_id, amp_id FROM dmd_device_product WHERE kind IN ('ampp', 'amp')";
