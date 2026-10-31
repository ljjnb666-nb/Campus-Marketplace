// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

// A business caller may not silently opt out of the central MFA gate. Keep the
// exit / re-consent allowlist explicit and reviewable as new routes are added.
const exemptions = [
  "src/actions/legal.ts", "src/actions/privacy.ts",
  "src/app/api/legal/acceptances/route.ts", "src/app/api/privacy/requests/route.ts",
  "src/app/api/privacy/export/route.ts", "src/app/api/privacy/export/[requestId]/download/route.ts",
].sort();

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(file) : /\.tsx?$/.test(file) && !/\.test\./.test(file) ? [file] : [];
  });
}

it("limits strong-auth opt-outs to privacy and legal recovery boundaries", () => {
  const actual = new Set<string>();
  for (const file of sources(path.resolve("src"))) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isPropertyAssignment(node) && node.name.getText(source).replace(/["']/g, "") === "requireStrongAuth") {
        expect([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword], file).toContain(node.initializer.kind);
        if (node.initializer.kind === ts.SyntaxKind.FalseKeyword) actual.add(path.relative(process.cwd(), file).replaceAll("\\", "/"));
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect([...actual].sort()).toEqual(exemptions);
});

it("limits identity-only page/action entry to legal, privacy and security recovery", () => {
  const actual = new Set<string>();
  for (const file of sources(path.resolve("src"))) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === "requireVerifiedPageUser") {
        actual.add(path.relative(process.cwd(), file).replaceAll("\\", "/"));
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect([...actual].sort()).toEqual([
    "src/actions/account-recovery.ts", "src/actions/account-sessions.ts", "src/app/legal/accept/page.tsx",
    "src/app/my/privacy/page.tsx", "src/app/my/security/page.tsx",
  ].sort());
});
