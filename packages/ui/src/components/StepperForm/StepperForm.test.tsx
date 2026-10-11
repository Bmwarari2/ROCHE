import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextField } from "../TextField/TextField";
import { StepperForm, type StepperFormStep } from "./StepperForm";

interface Values {
  fullName: string;
  phone: string;
}

const steps: StepperFormStep<Values>[] = [
  {
    id: "person",
    title: "About the person",
    validate: (values) => (values.fullName.trim() ? null : "Enter the person's full name"),
    content: ({ values, setValue }) => (
      <TextField
        label="Full name"
        value={values.fullName}
        onChange={(event) => setValue("fullName", event.target.value)}
      />
    ),
  },
  {
    id: "contact",
    title: "Next of kin",
    content: ({ values, setValue }) => (
      <TextField
        label="Phone number"
        value={values.phone}
        onChange={(event) => setValue("phone", event.target.value)}
      />
    ),
  },
];

const initialValues: Values = { fullName: "Ada Example", phone: "" };

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

function status(): string {
  return screen.getByRole("status").textContent ?? "";
}

describe("StepperForm autosave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves once, 800 ms after the last change, with the latest values", async () => {
    const onAutosave = vi.fn().mockResolvedValue(undefined);
    render(
      <StepperForm
        title="Admission"
        steps={steps}
        initialValues={initialValues}
        onAutosave={onAutosave}
        onSubmit={vi.fn()}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Full name" });
    expect(status()).toBe("");

    fireEvent.change(input, { target: { value: "Ada Exampl" } });
    await advance(500);
    fireEvent.change(input, { target: { value: "Ada Examples" } });
    expect(status()).toBe("Saving");

    // The debounce restarts on every change.
    await advance(799);
    expect(onAutosave).not.toHaveBeenCalled();

    await advance(1);
    expect(onAutosave).toHaveBeenCalledTimes(1);
    expect(onAutosave).toHaveBeenCalledWith({ fullName: "Ada Examples", phone: "" });

    await flushPromises();
    expect(status()).toBe("Saved");

    await advance(5000);
    expect(onAutosave).toHaveBeenCalledTimes(1);
  });

  it("shows that a failed save is being retried, then recovers", async () => {
    const onAutosave = vi
      .fn()
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce(undefined);
    render(
      <StepperForm
        title="Admission"
        steps={steps}
        initialValues={initialValues}
        onAutosave={onAutosave}
        onSubmit={vi.fn()}
        retryDelaysMs={[2000]}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Full name" }), {
      target: { value: "Ada B Example" },
    });
    await advance(800);
    await flushPromises();
    expect(status()).toBe("Not saved, retrying");

    await advance(1999);
    expect(onAutosave).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(onAutosave).toHaveBeenCalledTimes(2);
    await flushPromises();
    expect(status()).toBe("Saved");
  });
});

describe("StepperForm steps", () => {
  it("shows progress and moves between steps with Continue and Back", async () => {
    const onSubmit = vi.fn();
    render(
      <StepperForm
        title="Admission"
        steps={steps}
        initialValues={initialValues}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByText("Step 1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent("About the person");

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("Step 2 of 2")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Next of kin" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await flushPromises();
    expect(onSubmit).toHaveBeenCalledWith(initialValues);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Step 1 of 2")).toBeInTheDocument();
  });

  it("explains what to do when a step is not complete", () => {
    render(
      <StepperForm
        title="Admission"
        steps={steps}
        initialValues={{ fullName: "", phone: "" }}
        onSubmit={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter the person's full name");
    expect(screen.getByText("Step 1 of 2")).toBeInTheDocument();
  });
});
