import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * `@expo/cli` 57.0.28 asks for zod ^3.25.76, whose 3.x line is open to GHSA-mrhx-c7xc-m3w5 (high,
 * memory exhaustion on oversized arrays) with no fixed 3.x release. The root `package.json` pins
 * that copy to the fixed zod 4.6.6 with a scoped override (`"@expo/cli>zod": "4.6.6"`), until an
 * Expo SDK upgrade brings `@expo/cli` 57.0.33 or later, which no longer uses zod
 * (docs/compliance/vulnerability-exceptions.md). The CLI uses zod in two modules only, both for
 * development tools plugins (`expo start`): the plugin and output schemas, and the schema it builds
 * for a plugin's commands. These tests load those modules by the CLI's own dependency path, prove
 * they get zod 4, and check that each schema still accepts and refuses what it did under zod 3.
 */

type SafeParse = { safeParse: (value: unknown) => { success: boolean } };
type PluginSchemas = { PluginSchema: SafeParse; DevToolsPluginOutputSchema: SafeParse };
type CreateSchema = { createMCPDevToolsExtensionSchema: (plugin: object) => SafeParse };

const fromMobile = createRequire(import.meta.url);
const fromExpo = createRequire(fromMobile.resolve("expo/package.json"));
const fromCli = createRequire(fromExpo.resolve("@expo/cli/package.json"));
const zodVersion = (fromCli("zod/package.json") as { version: string }).version;
const schemas = fromCli("./build/src/start/server/DevToolsPlugin.schema.js") as PluginSchemas;
const { createMCPDevToolsExtensionSchema } = fromCli(
  "./build/src/start/server/createMCPDevToolsExtensionSchema.js",
) as CreateSchema;

const plugin = {
  packageName: "example-devtools-plugin",
  packageRoot: "/example",
  bannerTitle: true,
  cliExtensions: {
    description: "Example commands",
    entryPoint: "cli.js",
    commands: [
      {
        name: "reload",
        title: "Reload",
        environments: ["cli", "mcp"],
        parameters: [
          { name: "count", type: "number" },
          { name: "label", type: "text", description: "A label" },
        ],
      },
    ],
  },
};

describe("@expo/cli on the fixed zod", () => {
  it("loads zod 4.6.6 or later, outside GHSA-mrhx-c7xc-m3w5", () => {
    const [major = 0, minor = 0, patch = 0] = zodVersion.split(".").map(Number);
    expect(major).toBe(4);
    expect(minor * 1000 + patch).toBeGreaterThanOrEqual(6 * 1000 + 6);
  });

  it.each([
    ["a full plugin", plugin, true],
    ["a plugin with an empty package name", { ...plugin, packageName: "" }, false],
    [
      "a plugin with no commands",
      { ...plugin, cliExtensions: { ...plugin.cliExtensions, commands: [] } },
      false,
    ],
  ])("checks %s against the plugin schema", (_name, value, valid) => {
    expect(schemas.PluginSchema.safeParse(value).success).toBe(valid);
  });

  it.each([
    [
      "text and image lines",
      [
        { type: "text", text: "Done", level: "info" },
        { type: "image", url: "https://example.invalid/a.png" },
      ],
      true,
    ],
    ["an image whose url is not a URL", [{ type: "image", url: "not a url" }], false],
    ["a text line with an unknown level", [{ type: "text", text: "Done", level: "debug" }], false],
  ])("checks %s against the output schema", (_name, value, valid) => {
    expect(schemas.DevToolsPluginOutputSchema.safeParse(value).success).toBe(valid);
  });

  it.each([
    ["a known command with its parameters", { command: "reload", count: 2, label: "a" }, true],
    ["an unknown command", { command: "delete" }, false],
    ["an unknown key (the schema is strict)", { command: "reload", other: 1 }, false],
    ["a parameter of the wrong type", { command: "reload", count: "two" }, false],
  ])("checks %s against a plugin's command schema", (_name, value, valid) => {
    expect(createMCPDevToolsExtensionSchema(plugin).safeParse(value).success).toBe(valid);
  });
});
