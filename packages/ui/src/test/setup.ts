import "@testing-library/jest-dom/vitest";
import { setProjectAnnotations } from "@storybook/react";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import preview from "../../.storybook/preview";

// Stories rendered with composeStories get the same decorators and globals as in Storybook.
setProjectAnnotations(preview);

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
});

// jsdom lacks a few browser APIs that Radix UI relies on.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!("ResizeObserver" in globalThis)) {
  Object.defineProperty(globalThis, "ResizeObserver", { value: ResizeObserverStub });
}

const elementPrototype = Element.prototype as Element & {
  hasPointerCapture?: (pointerId: number) => boolean;
  releasePointerCapture?: (pointerId: number) => void;
  scrollIntoView?: () => void;
};

elementPrototype.hasPointerCapture ??= () => false;
elementPrototype.releasePointerCapture ??= () => {};
elementPrototype.scrollIntoView ??= () => {};
