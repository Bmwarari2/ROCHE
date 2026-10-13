import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import {
  SYNC_TOKEN_AUDIENCE,
  SYNC_TOKEN_ISSUER,
  SYNC_TOKEN_TTL_SECONDS,
  type SyncTokenClaims,
} from "@harbour/sync/streams";
import { exportJWK, type JWK, SignJWT } from "jose";

/**
 * Signs short-lived PowerSync tokens (ES256). PowerSync verifies them against the JWKS the API
 * publishes at GET /v1/sync/jwks. The token carries only the claims the sync streams read.
 */
export class SyncTokenSigner {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(
    private readonly keyId: string,
    pem?: string,
  ) {
    if (pem) {
      this.privateKey = createPrivateKey(pem);
      this.publicKey = createPublicKey(this.privateKey);
    } else {
      const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
      this.privateKey = pair.privateKey;
      this.publicKey = pair.publicKey;
    }
  }

  async sign(
    claims: SyncTokenClaims,
    now = new Date(),
  ): Promise<{ token: string; expiresAt: Date }> {
    const issuedAt = Math.floor(now.getTime() / 1000);
    const expiresAt = new Date((issuedAt + SYNC_TOKEN_TTL_SECONDS) * 1000);
    const token = await new SignJWT({
      tenant_id: claims.tenant_id,
      location_ids: [...claims.location_ids],
      people_location_ids: [...claims.people_location_ids],
      care_location_ids: [...claims.care_location_ids],
      entries_location_ids: [...claims.entries_location_ids],
      people_assigned: claims.people_assigned,
      care_assigned: claims.care_assigned,
      entries_assigned: claims.entries_assigned,
      handover_location_ids: [...claims.handover_location_ids],
      handover_assigned: claims.handover_assigned,
      entries_write_location_ids: [...claims.entries_write_location_ids],
      entries_write_assigned: claims.entries_write_assigned,
      ...(claims.entries_write_person_ids
        ? { entries_write_person_ids: [...claims.entries_write_person_ids] }
        : {}),
      offline_days: [...claims.offline_days],
    })
      .setProtectedHeader({ alg: "ES256", kid: this.keyId })
      .setSubject(claims.sub)
      .setIssuer(SYNC_TOKEN_ISSUER)
      .setAudience(SYNC_TOKEN_AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + SYNC_TOKEN_TTL_SECONDS)
      .sign(this.privateKey);
    return { token, expiresAt };
  }

  async jwks(): Promise<{ keys: JWK[] }> {
    const jwk = await exportJWK(this.publicKey);
    return { keys: [{ ...jwk, kid: this.keyId, alg: "ES256", use: "sig" }] };
  }

  get verificationKey(): KeyObject {
    return this.publicKey;
  }
}
