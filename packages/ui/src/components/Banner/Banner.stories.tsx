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

/** Part of the page (no live region), as the HR link's staleness note on rota screens. */
export const StaleOnThePage: Story = {
  args: {
    variant: "stale",
    announce: false,
    title: "Staff data from the HR platform may be out of date",
    description:
      "Thapsus Care has not had leave, sickness and staff changes from the HR platform since the time below. It still keeps people off the rota for absences it already knows about. Check the HR platform before you rely on who is available.",
    detail: (
      <>
        Last updated <time dateTime="2026-11-06T09:30:00Z">06/11/2026 09:30</time>
      </>
    ),
  },
};

export const StaleNeverSynced: Story = {
  args: {
    variant: "stale",
    announce: false,
    title: "Staff data from the HR platform may be out of date",
    description:
      "Thapsus Care has not had leave, sickness and staff changes from the HR platform yet. Check the HR platform before you rely on who is available.",
  },
};

export const StaleUnchecked: Story = {
  args: {
    variant: "stale",
    announce: false,
    title: "Staff data from the HR platform may be out of date",
    description:
      "Thapsus Care could not check when it last had staff changes from the HR platform. Check the HR platform before you rely on who is available.",
  },
};

export const Sample: Story = {
  args: { variant: "sample" },
};
