import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * A form handled in the browser (`onSubmit`) still works as plain HTML until the page hydrates. A
 * form with no method then submits by GET, which puts every field in the address: a password, a
 * one-time code, or a care note would reach the browser history and the server's request logs
 * (section 5.1, 5.3). Every such form says `method="post"`, so a submit before hydration posts
 * to the page instead. A form with a server action (`action`) is posted by Next.js already.
 */

const SOURCE = fileURLToPath(new URL(".", import.meta.url));

function componentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return componentFiles(path);
    return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [path] : [];
  });
}

function attributeText(attribute: ts.JsxAttributeLike, sourceFile: ts.SourceFile): string | null {
  if (!ts.isJsxAttribute(attribute) || !attribute.initializer) return null;
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text;
  return attribute.initializer.getText(sourceFile);
}

/** Forms in one file that submit in the browser without `method="post"` or a server action. */
function formsWithoutPost(path: string, text = readFileSync(path, "utf8")): string[] {
  const sourceFile = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const element = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : null;
    if (element && element.tagName.getText(sourceFile) === "form") {
      const names = new Map<string, string | null>();
      for (const attribute of element.attributes.properties) {
        if (ts.isJsxAttribute(attribute)) {
          names.set(attribute.name.getText(sourceFile), attributeText(attribute, sourceFile));
        }
      }
      const handledInBrowser = names.has("onSubmit");
      const posted = names.get("method")?.toLowerCase() === "post" || names.has("action");
      if (handledInBrowser && !posted) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile));
        found.push(`${relative(SOURCE, path)}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

describe("forms before hydration", () => {
  it("every form handled in the browser posts, so no field is ever sent in the address", () => {
    const offenders = componentFiles(SOURCE).flatMap((path) => formsWithoutPost(path));
    expect(offenders).toEqual([]);
  });

  it.each([
    [
      "a form handled in the browser with no method",
      '<form onSubmit={save}><input name="password" /></form>',
      1,
    ],
    ["one that says GET", '<form method="get" onSubmit={(e) => save(e)}></form>', 1],
    ["one that posts", '<form method="post" className="a" onSubmit={save}></form>', 0],
    ["one that posts, written in capitals", '<form method="POST" onSubmit={save}></form>', 0],
    ["one with a server action", "<form action={chooseOrganisation}></form>", 0],
    ["a search form with no handler", '<form role="search"></form>', 0],
  ])("flags %s: %s", (_name, form, expected) => {
    const sample = join(SOURCE, "sample.tsx");
    expect(formsWithoutPost(sample, `export const A = () => ${form};`)).toHaveLength(expected);
  });
});
