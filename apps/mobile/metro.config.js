// Metro configuration for the pnpm monorepo. Expo SDK 57's defaults already watch the workspace
// root and follow pnpm's symlinks; `expo export` confirms the bundle holds one copy of React,
// React Native and op-sqlite. Add resolver overrides here only if that stops being true.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default getDefaultConfig(projectRoot);
