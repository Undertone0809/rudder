import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

function getAsChildViolations() {
  const files = listTypeScriptFiles(getSourceRoot());
  const violations: string[] = [];

  for (const file of files) {
    const displayPath = path.relative(process.cwd(), file);
    const sourceText = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(displayPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    function visit(node: ts.Node) {
      if (ts.isJsxSelfClosingElement(node) && hasPossiblyEnabledAsChild(node.attributes)) {
        const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push(`${displayPath}:${location.line + 1}:${location.character + 1}`);
      }

      if (ts.isJsxElement(node) && hasPossiblyEnabledAsChild(node.openingElement.attributes)) {
        const children = node.children.filter((child) => {
          if (ts.isJsxText(child)) return child.getText(sourceFile).trim().length > 0;
          if (ts.isJsxExpression(child) && !child.expression) return false;
          return true;
        });
        if (children.length !== 1 || children.some((child) => ts.isJsxFragment(child))) {
          const location = sourceFile.getLineAndCharacterOfPosition(node.openingElement.getStart(sourceFile));
          violations.push(`${displayPath}:${location.line + 1}:${location.character + 1}`);
        }
      }

      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
  }

  return violations;
}

function getSourceRoot() {
  const repoSourceRoot = path.join(process.cwd(), "ui", "src");
  if (existsSync(repoSourceRoot)) return repoSourceRoot;
  return path.join(process.cwd(), "src");
}

function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(entryPath));
    } else if (/\.(tsx|ts)$/.test(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
}

function hasPossiblyEnabledAsChild(attributes: ts.JsxAttributes) {
  return attributes.properties.some((property) => {
    if (!ts.isJsxAttribute(property) || property.name.getText() !== "asChild") return false;
    if (!property.initializer) return true;
    if (!ts.isJsxExpression(property.initializer)) return false;
    return property.initializer.expression?.kind !== ts.SyntaxKind.FalseKeyword;
  });
}

describe("asChild usage", () => {
  it("passes exactly one direct child to Slot-backed components", () => {
    expect(getAsChildViolations()).toEqual([]);
  });
});
