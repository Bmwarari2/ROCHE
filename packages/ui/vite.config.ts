import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Used by Storybook (via @storybook/react-vite) to compile React and the Tailwind CSS entry.
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
