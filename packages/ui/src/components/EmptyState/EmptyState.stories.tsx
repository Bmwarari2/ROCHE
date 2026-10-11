import type { Meta, StoryObj } from "@storybook/react-vite";
import { NotebookPen, SearchX } from "lucide-react";
import { iconProps } from "../../lib/icon";
import { Button } from "../Button/Button";
import { EmptyState } from "./EmptyState";

const meta = {
  title: "Product shell/Empty state",
  component: EmptyState,
  args: {
    title: "No care notes yet",
    description: "Notes written by the team about Ada Example will appear here.",
    icon: <NotebookPen {...iconProps} />,
    action: <Button>Write the first note</Button>,
  },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const NoResults: Story = {
  args: {
    title: "No people match that search",
    description: "Check the spelling, or search by room number instead.",
    icon: <SearchX {...iconProps} />,
    action: <Button variant="secondary">Clear search</Button>,
    secondaryAction: <Button variant="tertiary">Add a person</Button>,
  },
};

export const TextOnly: Story = {
  args: {
    title: "Nothing to review",
    description: "All incidents have been reviewed.",
    icon: undefined,
    action: undefined,
  },
};
