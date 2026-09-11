import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 6C-2 §6 RAW AUTH ALLOWLIST 审计（grep-based 静态验证）。
 *
 * 冻结合同：任何仍直接调用 auth() / getServerSession() 的 production path
 * 只能属于 AUTH_INTERNAL / TRULY_PUBLIC_PRESENTATION / APPEAL_RESOLVER_INTERNAL。
 * 不得存在 "auth() → ordinary private data" 路径。
 *
 * 维护规则：把新文件加入 RAW_AUTH_ALLOWLIST 前必须先在 Planning/Review 中
 * 完成四类归类论证；read-only ≠ 允许 raw auth()。
 */

const RAW_AUTH_ALLOWLIST = [
  // AUTH_INTERNAL：Auth.js 本体与中央 resolver（auth() 的唯一定义与收敛点）
  "src/lib/auth.ts",
  "src/lib/server-auth.ts",
  "src/app/api/auth/",
  // TRULY_PUBLIC_PRESENTATION：身份 chrome（登录态/名字/role 导航链接），
  // 无私有业务载荷，所有目的地独立设防（requireUser/requireAdmin）
  "src/components/site/header.tsx",
];

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "e2e"]);

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      collectSourceFiles(full, out);
      continue;
    }
    if ((entry.endsWith(".ts") || entry.endsWith(".tsx")) && !entry.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

function toRel(file: string): string {
  return relative(process.cwd(), file).replaceAll("\\", "/");
}

function isAllowlisted(file: string): boolean {
  const rel = toRel(file);
  return RAW_AUTH_ALLOWLIST.some((prefix) => rel.startsWith(prefix));
}

describe("raw auth allowlist audit（Phase 6C-2 §6）", () => {
  const srcDir = join(process.cwd(), "src");

  it("auth() is never called outside the frozen allowlist", () => {
    const offenders = collectSourceFiles(srcDir)
      .filter((file) => !isAllowlisted(file))
      .filter((file) => {
        const content = readFileSync(file, "utf8");
        return /await auth\(\)/.test(content) || /\bauth\(\)[.;]/.test(content);
      })
      .map(toRel);

    expect(offenders).toEqual([]);
  });

  it("getServerSession is never imported outside src/lib/auth.ts", () => {
    const offenders = collectSourceFiles(srcDir)
      .filter((file) => !toRel(file).startsWith("src/lib/auth.ts"))
      .filter((file) => /getServerSession/.test(readFileSync(file, "utf8")))
      .map(toRel);

    expect(offenders).toEqual([]);
  });

  it("useSession is only used by the profile form session-update plumbing", () => {
    const offenders = collectSourceFiles(srcDir)
      .filter((file) => !toRel(file).startsWith("src/components/profile/profile-form.tsx"))
      .filter((file) => /useSession/.test(readFileSync(file, "utf8")))
      .map(toRel);

    expect(offenders).toEqual([]);
  });
});
