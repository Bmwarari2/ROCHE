import { appEnv } from "../config/app-env";
import { APP_ORIGIN } from "../config/constants";
import { createDemoAuthClient } from "../demo/demo-auth";
import { type AuthClient, createAuthClient } from "./auth-client";
import type { FetchLike } from "./http";

/** React Native's global fetch, wrapped so it can be passed around and replaced in tests. */
export const platformFetch: FetchLike = (input, init) => fetch(input, init);

export const authClient: AuthClient = appEnv.demoMode
  ? createDemoAuthClient()
  : createAuthClient({ baseUrl: appEnv.apiUrl, fetch: platformFetch, origin: APP_ORIGIN });
