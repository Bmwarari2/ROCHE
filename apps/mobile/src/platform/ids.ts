import * as Crypto from "expo-crypto";
import { uuidV7 } from "../sync/uuid-v7";

/** A UUIDv7 for an offline write, from the device clock and expo-crypto's secure random bytes. */
export function newEntryId(): string {
  return uuidV7(Date.now(), (length) => Crypto.getRandomBytes(length));
}
