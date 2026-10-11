import type { Decorator, Preview } from "@storybook/react-vite";
import "../src/styles/styles.css";

export type ThemeName = "light" | "dark";

/** Sets data-theme on the root element so tokens.css switches between light and dark. */
const withTheme: Decorator = (Story, context) => {
  const theme: ThemeName = context.globals.theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  return <Story />;
};

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Colour theme",
      toolbar: {
        title: "Theme",
        icon: "mirror",
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: "light",
  },
  decorators: [withTheme],
  parameters: {
    layout: "padded",
    // Fail the story's test when axe finds any violation.
    a11y: {
      test: "error",
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
};

export default preview;
