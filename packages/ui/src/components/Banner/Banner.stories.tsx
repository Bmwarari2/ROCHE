import type { Meta, StoryObj } from "@storybook/react-vite";
import { Banner } from "./Banner";

const meta = {
  title: "Product shell/Banner",
  component: Banner,
  args: { variant: "offline" },
} satisfies Meta<typeof Banner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Offline: Story = {};

export const Syncing: Story = {
  args: { variant: "syncing", description: "Sending 3 changes." },
};

export const SyncFailed: Story = {
  args: {
    variant: "syncFailed",
    detail: "Last tried at 14:32",
    onRetry: () => {},
  },
};

export const Retrying: Story = {
  args: {
    variant: "syncFailed",
    onRetry: () => {},
    retrying: true,
  },
};

export const Stale: Story = {
  args: {
    variant: "stale",
    detail: "Last updated 03/10/2026 09:15",
  },
};

export const Sample: Story = {
  args: { variant: "sample" },
};
