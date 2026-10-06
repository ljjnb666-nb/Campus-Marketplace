import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 软删除源码 guard（PRISMA-SOFT-DELETE-IMPL-01 / SOURCE_GUARD）。
 *
 * 扫描 src/** 全部 TypeScript 源文件，禁止软删除模型委托上的
 * delete / deleteMany 直调（accidental misuse guard）：
 *
 *   .user.delete(            .user.deleteMany(
 *   .product.delete(         .product.deleteMany(
 *   .errandTask.delete(      .errandTask.deleteMany(
 *   .serviceListing.delete(  .serviceListing.deleteMany(
 *   .rentalListing.delete(   .rentalListing.deleteMany(
 *
 * 边界声明（ARCH-01 Controller 修正）：
 * - 本扫描是 CI 期的**误用防线**，不是 perfect AST security boundary——
 *   别名/计算属性访问可绕过文本扫描；
 * - 真正的运行时语义 guard 是 extension fail-closed：软模型的
 *   delete/deleteMany 经扩展客户端一律抛
 *   SOFT_DELETE_EXPLICIT_DOMAIN_MUTATION_REQUIRED（且不存在 deletedAt 豁免），
 *   因此动态别名也无法静默执行软模型删除。
 * - 测试基建（scripts/、tests/）的裸 PrismaClient 物理清理不在本扫描范围
 *   （不属于业务扩展客户端）。
 */

const SOFT_DELETE_DELEGATES = [
  "user",
  "product",
  "errandTask",
  "serviceListing",
  "rentalListing",
] as const;

const DELETE_OPERATIONS = ["delete", "deleteMany"] as const;

// 运行时组合禁用模式：本文件源码不含任何字面量禁用串（不自匹配）
const FORBIDDEN_PATTERNS: readonly string[] = SOFT_DELETE_DELEGATES.flatMap((delegate) =>
  DELETE_OPERATIONS.map((operation) => `.${delegate}.${operation}(`),
);

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);

    if (stats.isDirectory()) {
      collectSourceFiles(full, acc);
      continue;
    }

    if (/\.(ts|tsx|mts|cts)$/.test(entry) && !entry.endsWith(".d.ts")) {
      acc.push(full);
    }
  }

  return acc;
}

/** 行级注释剔除：跳过以 //、/*、* 开头的行（文档示例中的反例不构成违例） */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();

  return (
    trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")
  );
}

describe("soft-delete source guard", () => {
  it("src/** has zero soft-model delegate delete/deleteMany call sites", () => {
    // vitest 始终从仓库根运行（本地 npm scripts 与 CI 一致），cwd 下即 src/
    const srcDir = join(process.cwd(), "src");
    const violations: string[] = [];

    for (const file of collectSourceFiles(srcDir)) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);

      lines.forEach((line, index) => {
        if (isCommentLine(line)) {
          return;
        }

        for (const pattern of FORBIDDEN_PATTERNS) {
          if (line.includes(pattern)) {
            violations.push(`${file}:${index + 1} → ${line.trim()}`);
          }
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
