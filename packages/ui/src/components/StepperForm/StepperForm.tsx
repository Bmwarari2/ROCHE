"use client";

import { Check, CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cx } from "../../lib/cx";
import { Heading } from "../../lib/heading";
import { iconProps } from "../../lib/icon";
import { VisuallyHidden } from "../../lib/VisuallyHidden";
import { Button } from "../Button/Button";

export type AutosaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

export interface StepperFormStepContext<Values> {
  values: Values;
  setValue: <Key extends keyof Values>(key: Key, value: Values[Key]) => void;
  setValues: (patch: Partial<Values>) => void;
}

export interface StepperFormStep<Values> {
  id: string;
  title: string;
  description?: string;
  /** Renders the fields for this step. */
  content: (context: StepperFormStepContext<Values>) => ReactNode;
  /**
   * Returns a message when the step cannot be completed yet, for example "Enter a date of birth".
   * Say what to do; never blame the person.
   */
  validate?: (values: Values) => string | null | undefined;
}

export interface StepperFormProps<Values> {
  title: string;
  steps: readonly StepperFormStep<Values>[];
  initialValues: Values;
  /** Called with the latest values 800 ms (by default) after the last change. */
  onAutosave?: (values: Values) => Promise<void> | void;
  onSubmit: (values: Values) => Promise<void> | void;
  autosaveDelayMs?: number;
  /** Delays between automatic retries after a failed autosave; the last one repeats. */
  retryDelaysMs?: readonly number[];
  initialStep?: number;
  onStepChange?: (index: number) => void;
  submitLabel?: string;
  nextLabel?: string;
  backLabel?: string;
  headingLevel?: 2 | 3;
  className?: string;
}

const statusText: Record<AutosaveStatus, string> = {
  idle: "",
  pending: "Saving",
  saving: "Saving",
  saved: "Saved",
  error: "Not saved, retrying",
};

/**
 * Renders a step's fields as its own component, keyed by step, so a step's render function may use
 * hooks without disturbing the form's own hooks when the person moves between steps.
 */
function StepContent<Values>({
  render,
  context,
}: {
  render: StepperFormStep<Values>["content"];
  context: StepperFormStepContext<Values>;
}) {
  return <>{render(context)}</>;
}

function StatusIcon({ status }: { status: AutosaveStatus }) {
  switch (status) {
    case "pending":
    case "saving":
      return <LoaderCircle {...iconProps} size={16} className="hb-stepper__spinner" />;
    case "saved":
      return <CircleCheck {...iconProps} size={16} />;
    case "error":
      return <CircleAlert {...iconProps} size={16} />;
    default:
      return null;
  }
}

/**
 * A form split into steps with progress, Back and Continue, and autosave. Autosave calls
 * `onAutosave(values)` once changes have settled for 800 ms, shows "Saving", "Saved" or
 * "Not saved, retrying", and retries failed saves on its own.
 */
export function StepperForm<Values extends object>({
  title,
  steps,
  initialValues,
  onAutosave,
  onSubmit,
  autosaveDelayMs = 800,
  retryDelaysMs = [2000, 5000, 10000, 30000],
  initialStep = 0,
  onStepChange,
  submitLabel = "Submit",
  nextLabel = "Continue",
  backLabel = "Back",
  headingLevel = 2,
  className,
}: StepperFormProps<Values>) {
  const titleId = useId();
  const stepHeadingId = useId();
  const errorId = useId();
  const [values, setValuesState] = useState<Values>(initialValues);
  const [current, setCurrent] = useState(() =>
    Math.min(Math.max(initialStep, 0), Math.max(steps.length - 1, 0)),
  );
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const latestValues = useRef(values);
  const version = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempts = useRef(0);
  const mounted = useRef(true);
  const onAutosaveRef = useRef(onAutosave);
  const onStepChangeRef = useRef(onStepChange);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const hasNavigated = useRef(false);

  useEffect(() => {
    onAutosaveRef.current = onAutosave;
    onStepChangeRef.current = onStepChange;
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const save = useCallback(async () => {
    const autosave = onAutosaveRef.current;
    if (!autosave) return;
    const savingVersion = version.current;
    setStatus("saving");
    try {
      await autosave(latestValues.current);
      if (!mounted.current || savingVersion !== version.current) return;
      attempts.current = 0;
      setStatus("saved");
    } catch {
      if (!mounted.current || savingVersion !== version.current) return;
      setStatus("error");
      const delay =
        retryDelaysMs[Math.min(attempts.current, retryDelaysMs.length - 1)] ?? autosaveDelayMs;
      attempts.current += 1;
      timer.current = setTimeout(() => {
        timer.current = null;
        void save();
      }, delay);
    }
  }, [retryDelaysMs, autosaveDelayMs]);

  const scheduleSave = useCallback(() => {
    if (!onAutosaveRef.current) return;
    if (timer.current) clearTimeout(timer.current);
    attempts.current = 0;
    setStatus("pending");
    timer.current = setTimeout(() => {
      timer.current = null;
      void save();
    }, autosaveDelayMs);
  }, [autosaveDelayMs, save]);

  const setValues = useCallback(
    (patch: Partial<Values>) => {
      const next = { ...latestValues.current, ...patch };
      latestValues.current = next;
      version.current += 1;
      setValuesState(next);
      setError(null);
      scheduleSave();
    },
    [scheduleSave],
  );

  const setValue = useCallback(
    <Key extends keyof Values>(key: Key, value: Values[Key]) => {
      setValues({ [key]: value } as unknown as Partial<Values>);
    },
    [setValues],
  );

  // Move focus to the new step's heading after Back or Continue, so screen readers announce it.
  useEffect(() => {
    if (!hasNavigated.current) return;
    stepHeading.current?.focus();
    onStepChangeRef.current?.(current);
  }, [current]);

  const step = steps[current];
  if (!step) return null;
  const isFirst = current === 0;
  const isLast = current === steps.length - 1;
  const progress = Math.round(((current + 1) / steps.length) * 100);

  const goTo = (index: number) => {
    hasNavigated.current = true;
    setError(null);
    setCurrent(index);
  };

  const onFormSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = step.validate?.(latestValues.current);
    if (message) {
      setError(message);
      return;
    }
    if (!isLast) {
      goTo(current + 1);
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(latestValues.current);
    } catch {
      if (mounted.current) {
        setError("This could not be sent. Your answers are still here, so you can try again.");
      }
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  };

  return (
    <form
      className={cx("hb-stepper", className)}
      aria-labelledby={titleId}
      noValidate
      onSubmit={onFormSubmit}
    >
      <div className="hb-stepper__header">
        <Heading level={headingLevel} id={titleId} className="hb-stepper__title">
          {title}
        </Heading>
        {onAutosave ? (
          <p
            className={cx("hb-stepper__status", `hb-stepper__status--${status}`)}
            role="status"
            aria-live="polite"
          >
            <StatusIcon status={status} />
            <span>{statusText[status]}</span>
          </p>
        ) : null}
      </div>

      <div className="hb-stepper__progress">
        <p className="hb-stepper__count">
          Step {current + 1} of {steps.length}
        </p>
        <div className="hb-stepper__bar" aria-hidden="true">
          <span className="hb-stepper__bar-fill" style={{ width: `${progress}%` }} />
        </div>
        <ol className="hb-stepper__steps">
          {steps.map((item, index) => {
            const state = index < current ? "complete" : index === current ? "current" : "upcoming";
            return (
              <li
                key={item.id}
                className="hb-stepper__step"
                data-state={state}
                aria-current={index === current ? "step" : undefined}
              >
                <span className="hb-stepper__marker" aria-hidden="true">
                  {state === "complete" ? <Check {...iconProps} size={14} /> : index + 1}
                </span>
                <span className="hb-stepper__step-title">{item.title}</span>
                {state === "complete" ? <VisuallyHidden> (done)</VisuallyHidden> : null}
              </li>
            );
          })}
        </ol>
      </div>

      <section className="hb-stepper__panel" aria-labelledby={stepHeadingId}>
        <Heading
          level={headingLevel === 2 ? 3 : 4}
          id={stepHeadingId}
          ref={stepHeading}
          tabIndex={-1}
          className="hb-stepper__step-heading"
        >
          {step.title}
        </Heading>
        {step.description ? <p className="hb-stepper__description">{step.description}</p> : null}
        <div className="hb-stepper__fields">
          <StepContent
            key={step.id}
            render={step.content}
            context={{ values, setValue, setValues }}
          />
        </div>
      </section>

      {error ? (
        <p id={errorId} className="hb-stepper__error" role="alert">
          <CircleAlert {...iconProps} size={16} />
          <span>{error}</span>
        </p>
      ) : null}

      <div className="hb-stepper__actions">
        <Button variant="secondary" onClick={() => goTo(current - 1)} disabled={isFirst}>
          {backLabel}
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={submitting}
          aria-describedby={error ? errorId : undefined}
        >
          {isLast ? submitLabel : nextLabel}
        </Button>
      </div>
    </form>
  );
}
