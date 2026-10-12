import { z } from "zod";

/**
 * Client ids on create routes (care.md section 5; master prompt section 6; HZ-029): a client
 * UUIDv7, made by the form or the device and kept across retries of the same save, so a save
 * tried again after its outcome was lost records once. It travels as the body's `id` or as the
 * `Idempotency-Key` header; when both are sent they must be the same id.
 */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

export const ClientIdHeaders = z.object({
  [IDEMPOTENCY_KEY_HEADER]: z.uuid().optional().meta({
    description:
      "The record's client id (a UUIDv7 kept across retries), when the body does not carry it as `id`; the same id when it does",
  }),
});
