import { z } from "zod";
import { StaffName } from "./staff";

/**
 * Single sign-on configuration (PLAT-005; platform.md, Phase 2: single sign-on, rules 18 to 22;
 * ADR-0091). The private key stays in the managed secret store: only its name crosses the API.
 */

const isoDateTime = z.iso.datetime({ offset: true });

export const SsoConnection = z
  .object({
    id: z.uuid(),
    providerId: z.string(),
    issuer: z.string(),
    discoveryUrl: z.string(),
    clientId: z.string(),
    /** The key's name in the managed secret store, never the key. */
    privateKeyRef: z.string(),
    privateKeyId: z.string().nullable(),
    allowedRoleKeys: z.array(z.string()),
    enabled: z.boolean(),
    /** Where the web app starts this organisation's sign-in (POST, Better Auth). */
    signInPath: z.string(),
    /** The redirect URI to register with the identity provider. */
    redirectUri: z.string(),
    version: z.number().int(),
  })
  .meta({ id: "SsoConnection" });
export type SsoConnection = z.infer<typeof SsoConnection>;

export const SsoDomain = z
  .object({
    id: z.uuid(),
    domain: z.string(),
    verifiedAt: isoDateTime.nullable(),
    verifiedBy: StaffName.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "SsoDomain" });

export const SsoConfiguration = z
  .object({ connection: SsoConnection.nullable(), domains: z.array(SsoDomain) })
  .meta({ id: "SsoConfiguration" });

export const SaveSsoConnection = z
  .object({
    issuer: z.string().trim().max(500),
    discoveryUrl: z.string().trim().max(500),
    clientId: z.string().trim().min(1).max(200),
    privateKeyRef: z.string().trim().max(200),
    privateKeyId: z.string().trim().min(1).max(200).nullable().default(null),
    /** Only `private_key_jwt`: client secrets are refused (rule 18). */
    tokenEndpointAuthentication: z
      .enum(["private_key_jwt", "client_secret_basic", "client_secret_post"])
      .default("private_key_jwt"),
    allowedRoleKeys: z.array(z.string().min(1).max(100)).max(50),
    enabled: z.boolean(),
    /** The connection's `version` when changing it; null to create the first one. */
    expectedVersion: z.number().int().nullable(),
  })
  .meta({ id: "SaveSsoConnection" });
export type SaveSsoConnection = z.infer<typeof SaveSsoConnection>;

export const NewSsoDomain = z
  .object({ domain: z.string().trim().min(3).max(253) })
  .meta({ id: "NewSsoDomain" });

/** The record to publish; the token is shown here once and kept only as a hash. */
export const SsoDomainChallenge = z
  .object({ domain: SsoDomain, record: z.object({ name: z.string(), value: z.string() }) })
  .meta({ id: "SsoDomainChallenge" });

export const SsoDomainChange = z
  .object({ expectedVersion: z.number().int() })
  .meta({ id: "SsoDomainChange" });
