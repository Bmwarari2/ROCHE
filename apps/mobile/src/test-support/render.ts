/**
 * Test support: draws a component with react-test-renderer against the stand-in for the native
 * runtime (`react-native-stub.ts`), then reads what a carer would see and presses what they would
 * press. Host components keep their props, so tests find them by `testID`.
 */
import { act, type ReactElement } from "react";

export interface RenderedNode {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: ReadonlyArray<RenderedNode | string> | null;
}

interface TestInstance {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
  findAll(predicate: (node: TestInstance) => boolean): TestInstance[];
}

interface TestRenderer {
  toJSON(): RenderedNode | RenderedNode[] | null;
  unmount(): void;
  readonly root: TestInstance;
}

interface TestRendererModule {
  create(element: ReactElement): TestRenderer;
}

export interface Rendered {
  /** The host tree as drawn now. */
  nodes(): RenderedNode[];
  /** Every piece of text drawn now, in order, with each Text element's children joined. */
  texts(): string[];
  /** The host element with this test id, or null. */
  find(testID: string): { readonly props: Record<string, unknown> } | null;
  /** Presses the host element with this test id. */
  press(testID: string): Promise<void>;
  /** Types into the text input with this test id. */
  typeInto(testID: string, text: string): Promise<void>;
  unmount(): void;
}

export function textsOf(nodes: ReadonlyArray<RenderedNode | string>): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (typeof node === "string") continue;
    if (node.type === "Text") {
      out.push((node.children ?? []).filter((c): c is string => typeof c === "string").join(""));
    }
    out.push(...textsOf((node.children ?? []).filter((c) => typeof c !== "string")));
  }
  return out;
}

/** Waits for promises the component started (a press that counts, a save) to settle. */
export async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

export async function render(element: ReactElement): Promise<Rendered> {
  // A variable module name keeps the renderer, a test-only package, out of the app's type graph.
  const name = "react-test-renderer";
  const renderer = (await import(/* @vite-ignore */ name)) as TestRendererModule;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let tree: TestRenderer | null = null;
  await act(async () => {
    tree = renderer.create(element);
  });
  const current = () => {
    if (!tree) throw new Error("not rendered");
    return tree as TestRenderer;
  };
  const nodes = () => {
    const json = current().toJSON();
    return json === null ? [] : Array.isArray(json) ? json : [json];
  };
  const find = (testID: string) =>
    current().root.findAll((n) => typeof n.type === "string" && n.props.testID === testID)[0] ??
    null;
  const call = async (testID: string, prop: string, ...args: unknown[]) => {
    const host = find(testID);
    const handler = host?.props[prop];
    if (typeof handler !== "function") throw new Error(`nothing to ${prop} at ${testID}`);
    await act(async () => {
      handler(...args);
    });
    await settle();
  };
  return {
    nodes,
    texts: () => textsOf(nodes()),
    find,
    press: (testID) => call(testID, "onPress", {}),
    typeInto: (testID, text) => call(testID, "onChangeText", text),
    unmount: () => current().unmount(),
  };
}
