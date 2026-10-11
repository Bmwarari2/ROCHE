import { parseEnv } from "./env";

/**
 * The running app's configuration. Each `process.env.EXPO_PUBLIC_*` reference must stay written out
 * in full so Expo can inline it at build time.
 */
export const appEnv = parseEnv(
  {
    EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
    EXPO_PUBLIC_DEMO_MODE: process.env.EXPO_PUBLIC_DEMO_MODE,
  },
  { allowInsecure: __DEV__ },
);
