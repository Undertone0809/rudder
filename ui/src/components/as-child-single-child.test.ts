import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

function getAsChildViolations() {
  const files = execFileSync("rg", ["--files", "ui/src"], { encoding: "utf8" })
    .split("\n")
    .filter((file) => /\.(tsx|ts)$/.test(file));
  const violations: string[] = [];

  for (const file of files) {
    const sourceText = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    function visit(node: ts.Node) {
      if (ts.isJsxElement(node) && hasBooleanAsChild(node.openingElement.attributes)) {
        const children = node.children.filter((child) => {
          if (ts.isJsxText(child)) return child.getText(sourceFile).trim().length > 0;
          if (ts.isJsxExpression(child) && !child.expression) return false;
          return true;
        });
        if (children.length !== 1 || children.some((child) => ts.isJsxFragment(child))) {
          const location = sourceFile.getLineAndCharacterOfPosition(node.openingElement.getStart(sourceFile));
          violations.push(`${file}:${location.line + 1}:${location.character + 1}`);
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return violations;
}

function hasBooleanAsChild(attributes: ts.JsxAttributes) {
  return attributes.properties.some((property) => {
    if (!ts.isJsxAttribute(property) || property.name.getText() !== "asChild") return false;
    if (!property.initializer) return true;
    return ts.isJsxExpression(property.initializer)
      && property.initializer.expression?.kind === ts.SyntaxKind.TrueKeyword;
  });
}

describe("asChild usage", () => {
  it("passes exactly one direct child to Slot-backed components", () => {
    expect(getAsChildViolations()).toEqual([]);
  });
});
