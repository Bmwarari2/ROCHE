import { composeStories } from "@storybook/react";
import { act, render } from "@testing-library/react";
import axe from "axe-core";
import type { ComponentType } from "react";
import { describe, expect, it } from "vitest";

/**
 * Renders every story of every component in the light and the dark theme and runs axe-core over
 * the whole body, so portalled content (sheets, toasts, menus) is checked too.
 *
 * Only the color-contrast rule is disabled: jsdom does not lay out or paint, so axe cannot compute
 * contrast reliably here. Contrast is checked by the Storybook a11y addon in a real browser and by
 * the documented token ratios.
 */

type StoriesModule = Parameters<typeof composeStories>[0];

const modules = import.meta.glob<StoriesModule>("../components/**/*.stories.tsx", { eager: true });
const themes = ["light", "dark"] as const;

const axeOptions: axe.RunOptions = {
  rules: {
    "color-contrast": { enabled: false },
  },
};

function describeViolations(violations: axe.Result[]): string[] {
  return violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target.join(" ")).join(", ")})`,
  );
}

it("finds the stories", () => {
  expect(Object.keys(modules).length).toBeGreaterThanOrEqual(15);
});

for (const [path, module] of Object.entries(modules)) {
  const componentName = path.split("/").at(-2) ?? path;
  describe(componentName, () => {
    for (const theme of themes) {
      const stories = composeStories(module, { initialGlobals: { theme } }) as unknown as Record<
        string,
        ComponentType
      >;
      for (const [storyName, Story] of Object.entries(stories)) {
        it(`${storyName} has no axe violations in the ${theme} theme`, async () => {
          render(
            <main>
              <Story />
            </main>,
          );
          // Let effects, portals and Radix presence settle.
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
          });
          expect(document.documentElement.dataset.theme).toBe(theme);
          const results = await axe.run(document.body, axeOptions);
          expect(describeViolations(results.violations)).toEqual([]);
        });
      }
    }
  });
}
