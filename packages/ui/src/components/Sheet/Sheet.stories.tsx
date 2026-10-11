import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "../Button/Button";
import { TextField } from "../TextField/TextField";
import { Sheet, SheetClose } from "./Sheet";

const form = (
  <div style={{ display: "grid", gap: 16 }}>
    <TextField label="Full name" defaultValue="Ben Sample" />
    <TextField label="Role" defaultValue="Senior carer" />
    <TextField label="Email" type="email" defaultValue="ben.sample@example.invalid" />
  </div>
);

const footer = (
  <>
    <SheetClose asChild>
      <Button variant="secondary">Cancel</Button>
    </SheetClose>
    <Button>Save</Button>
  </>
);

const meta = {
  title: "Product shell/Sheet",
  component: Sheet,
  args: {
    title: "Edit team member",
    description: "Changes apply from the next shift.",
    children: form,
    footer,
  },
} satisfies Meta<typeof Sheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  args: { defaultOpen: true },
};

export const WithTrigger: Story = {
  args: { trigger: <Button variant="secondary">Edit Ben Sample</Button> },
};

export const Large: Story = {
  args: {
    defaultOpen: true,
    size: "large",
    title: "Add a person",
    description: undefined,
  },
};
