import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Every word the web app shows comes from the @harbour/i18n catalogues (section 5.4), so Welsh
 * and per-tenant wording can follow without touching components. This parses each component and
 * fails on words written straight into JSX text or into attributes people read or hear.
 * Punctuation between translated parts (", ", "›") is allowed.
 */

const SOURCE = fileURLToPath(new URL(".", import.meta.url));

/** Attributes whose value is shown or read out. */
const COPY_ATTRIBUTES = new Set([
  "alt",
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "aria-valuetext",
  "placeholder",
  "title",
  "label",
  "hint",
  "error",
  "description",
  "caption",
]);

const WORD = /\p{L}{2,}/u;

function componentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return componentFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

interface Literal {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function literalCopy(file: string, text: string): Literal[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Literal[] = [];
  const report = (node: ts.Node, value: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push({ file: relative(SOURCE, file), line: line + 1, text: value.trim() });
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && WORD.test(node.text)) report(node, node.text);
    if (ts.isJsxAttribute(node) && COPY_ATTRIBUTES.has(node.name.getText(source))) {
      const value = node.initializer;
      if (value && ts.isStringLiteral(value) && WORD.test(value.text)) report(node, value.text);
      if (
        value &&
        ts.isJsxExpression(value) &&
        value.expression &&
        (ts.isStringLiteral(value.expression) ||
          ts.isNoSubstitutionTemplateLiteral(value.expression) ||
          ts.isTemplateExpression(value.expression)) &&
        WORD.test(value.expression.getText(source))
      ) {
        report(node, value.expression.getText(source));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("web copy", () => {
  const files = componentFiles(SOURCE);

  it("finds the components", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("comes from the i18n catalogues, not literals in components", () => {
    const literals = files.flatMap((file) => literalCopy(file, readFileSync(file, "utf8")));
    expect(literals.map(({ file, line, text }) => `${file}:${line} ${text}`)).toEqual([]);
  });

  it("would catch a literal", () => {
    const sample = `export const A = () => <p title="Hello there">Sorry, {name}<b aria-hidden="true">›</b></p>;`;
    expect(literalCopy(join(SOURCE, "sample.tsx"), sample).map((l) => l.text)).toEqual([
      "Hello there",
      "Sorry,",
    ]);
  });
});
