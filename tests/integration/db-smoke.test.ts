import { PrismaClient } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";

/**
 * 真实数据库集成冒烟测试。
 *
 * 仅当环境变量 INTEGRATION_DATABASE_URL 指向一个已应用迁移的真实 PostgreSQL
 * (本地 throwaway 容器或 CI 服务容器)时才会执行,否则整个 describe 被跳过。
 *
 * 注意:这里必须使用独立的 PrismaClient 实例(而非 @/lib/prisma 单例),
 * 因为单例读取 .env 中的 DATABASE_URL,无法切换到集成测试库;
 * describe.skipIf 跳过时回调体仍会在收集阶段执行,因此构造客户端前必须判空。
 */
const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const prisma = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

describe.skipIf(!integrationDatabaseUrl)(
  "数据库集成冒烟测试 (db-smoke)",
  () => {
    afterAll(async () => {
      await prisma?.$disconnect();
    });

    it("数据库连接正常:$queryRaw SELECT 1 可执行", async () => {
      const rows =
        await prisma!.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].ok)).toBe(1);
    });

    it("迁移已应用:核心表存在于 public schema", async () => {
      // schema.prisma 未使用 @@map,因此表名与模型名一致(User / ModerationKeyword ...)
      const tables = await prisma!.$queryRaw<
        Array<{ table_name: string }>
      >`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
      const names = tables.map((row) => row.table_name);
      expect(names).toContain("User");
      expect(names).toContain("ModerationKeyword");
    });

    it("基础 CRUD 可用:在事务中创建→读取→删除一次性 ModerationKeyword", async () => {
      const keyword = `__smoke_${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`;

      await prisma!.$transaction(async (tx) => {
        const created = await tx.moderationKeyword.create({
          data: { keyword },
        });
        expect(created.id).toBeTruthy();
        expect(created.keyword).toBe(keyword);

        const found = await tx.moderationKeyword.findUnique({
          where: { keyword },
        });
        expect(found?.id).toBe(created.id);

        await tx.moderationKeyword.delete({ where: { id: created.id } });

        const gone = await tx.moderationKeyword.findUnique({
          where: { keyword },
        });
        expect(gone).toBeNull();
      });
    });
  },
);
