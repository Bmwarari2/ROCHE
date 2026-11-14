// App entry. The Intl polyfills must load before expo-router, so before any screen formats a message
// (src/platform/intl-polyfills.ts explains why). Keep this import first.
import "./src/platform/intl-polyfills";
import "expo-router/entry";
