import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "../Button/Button";
import { Toast, ToastProvider, useToast } from "./Toast";

const meta = {
  title: "Product shell/Toast",
  component: Toast,
  decorators: [
    (Story) => (
      <ToastProvider>
        <Story />
      </ToastProvider>
    ),
  ],
  args: {
    title: "Care note saved",
    description: "Ada Example, 03/10/2026 14:05",
    variant: "success",
    defaultOpen: true,
    duration: 1000000,
  },
} satisfies Meta<typeof Toast>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Success: Story = {};

export const WithUndo: Story = {
  args: {
    title: "Shift removed from the rota",
    description: "Ben Sample, night shift on 14/10/2026",
    variant: "neutral",
    action: {
      label: "Undo",
      altText: "Undo removing the shift. You can also add it again from the rota.",
      onAction: () => {},
    },
  },
};

export const ErrorToast: Story = {
  name: "Error",
  args: {
    title: "The photo could not be uploaded",
    description: "Check the connection and try again. The care note is saved.",
    variant: "error",
  },
};

function ToastDemo() {
  const { toast } = useToast();
  return (
    <Button
      onClick={() =>
        toast({
          title: "Medicines round saved",
          description: "12 of 12 recorded",
          variant: "success",
        })
      }
    >
      Save the round
    </Button>
  );
}

export const FromHook: Story = {
  args: { defaultOpen: false },
  render: () => <ToastDemo />,
};
