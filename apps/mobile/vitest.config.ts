import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const stub = (file: string) =>
  fileURLToPath(new URL(`./src/test-support/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Render tests draw components with react-test-renderer in Node: react-native and the icon
    // modules (which need the native runtime) are replaced by plain stand-ins.
    alias: [
      { find: /^react-native$/, replacement: stub("react-native-stub.ts") },
      { find: /^lucide-react-native\/icons\/.+$/, replacement: stub("icon-stub.ts") },
    ],
  },
  test: {
    environment: "node",
    // Pure modules are unit-tested here, and a few components are rendered against stand-ins for
    // the native runtime; screens on a device are covered by the Maestro flows in .maestro/.
    include: ["src/**/*.test.ts"],
    passWithNoTests: false,
    env: { TZ: "Europe/London" },
  },
});
