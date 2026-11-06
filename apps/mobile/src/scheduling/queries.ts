/**
 * The phone's reads for the member's own shifts and clock (scheduling.md section 18). The sync
 * streams send only the member's own rows (`my_shifts`, `my_clock_events`), and each read keeps to
 * the signed-in tenant as well.
 */
export const MY_SHIFTS_SQL = `SELECT id, location_id, label, kind, starts_at, ends_at, break_minutes,
  changed_after_publish_at FROM shift WHERE tenant_id = ? ORDER BY starts_at`;

export const MY_CLOCK_EVENTS_SQL = `SELECT id, kind, shift_id, location_id, device_time, recorded_at
  FROM clock_event WHERE tenant_id = ? AND worker_id = ? ORDER BY device_time`;

/** Lone-working actions not yet sent: `lone_worker_outbox` is insert-only, so only the queue has them. */
export const QUEUED_LONE_WORKER_SQL = `SELECT data FROM ps_crud
  WHERE data LIKE '%"lone_worker_outbox"%' ORDER BY id`;

export const INSERT_CLOCK_EVENT_SQL = `INSERT INTO clock_event (id, tenant_id, worker_id, kind,
  shift_id, location_id, device_time, recorded_at, flags) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '[]')`;

export const INSERT_LONE_WORKER_SQL = `INSERT INTO lone_worker_outbox (id, tenant_id, action,
  session_id, body, queued_at) VALUES (?, ?, ?, ?, ?, ?)`;

/**
 * The demo database is local-only, so nothing reaches the upload queue: its lone-working actions
 * stay in the table, read in the queue's own shape.
 */
export const DEMO_QUEUED_LONE_WORKER_SQL = `SELECT json_object('op', 'PUT', 'type',
  'lone_worker_outbox', 'id', id, 'data', json_object('action', action, 'session_id', session_id,
  'body', body)) AS data FROM lone_worker_outbox ORDER BY queued_at`;
