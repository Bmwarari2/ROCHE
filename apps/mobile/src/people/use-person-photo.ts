import { useEffect, useState } from "react";
import type { ImageURISource } from "react-native";
import { useSession } from "../app-state/session";
import { platformFetch } from "../auth/clients";
import { appEnv } from "../config/app-env";
import { fetchPersonPhoto, PhotoMemoryCache, photoCacheKey } from "./photo";

/** Memory-only photo cache, shared by all screens and cleared on sign-out. */
const photoCache = new PhotoMemoryCache(60);

export function clearPhotoCache(): void {
  photoCache.clear();
}

/**
 * The person's photo as an in-memory data URI, or null (show initials) when there is no photo, the
 * device is offline and the photo is not cached, or the fetch fails.
 */
export function usePersonPhoto(
  personId: string,
  photoDocumentId: string | null,
): ImageURISource | null {
  const { token } = useSession();
  const key = photoDocumentId ? photoCacheKey(personId, photoDocumentId) : null;
  const [uri, setUri] = useState<string | null>(() => (key ? (photoCache.get(key) ?? null) : null));

  useEffect(() => {
    if (!key || !token || appEnv.demoMode) {
      setUri(null);
      return;
    }
    const cached = photoCache.get(key);
    if (cached) {
      setUri(cached);
      return;
    }
    let active = true;
    fetchPersonPhoto({ apiUrl: appEnv.apiUrl, personId, token, fetch: platformFetch }).then(
      (result) => {
        if (result) photoCache.set(key, result);
        if (active) setUri(result);
      },
    );
    return () => {
      active = false;
    };
  }, [key, token, personId]);

  return uri ? { uri } : null;
}
