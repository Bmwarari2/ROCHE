import * as Crypto from "expo-crypto";

/** SHA-256 of the text (UTF-8) as standard base64, for the handover's seen token. */
export function sha256Base64(text: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
}
