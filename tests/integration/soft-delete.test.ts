import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 软删除扩展 deleteMany 修复的真实数据库集成测试。
 *
 * 背景：query 组件无法改写操作类型——deleteMany 钩子内 query(带 data 的 args)
 * 仍按 deleteMany 执行，会 PrismaClientValidationError（带 data 不是合法 deleteMany
 * 输入）。修复后 deleteMany 与 delete 一致，改写走 base client 的 updateMany 委托。
 *
 * 仅当 INTEGRATION_DATABASE_URL 指向已应用迁移的真实 PostgreSQL 时执行。
 * 覆盖：single/bulk 软删除、默认查询排除、显式 deletedAt 豁免（硬删除）、
 * 事务行为、重复删除幂等。
 */

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

describe.skipIf(!integrationDatabaseUrl)("软删除扩展集成测试 (soft-delete)", () => {
  // 与 db-smoke 同理：独立 PrismaClient 连 INTEGRATION_DATABASE_URL，
  // 再挂载被测扩展，避免 @/lib/prisma 单例的 DATABASE_URL（开发库）干扰。
  // $extends 的泛型重载导致返回类型无法直接命名，这里以基础 client 类型
  // 承载（deleteMany 等被改写操作的返回形状与原生一致）。
  type PrismaModule = typeof import("@prisma/client");
  let basePrisma: InstanceType<PrismaModule["PrismaClient"]>;
  let prisma: InstanceType<PrismaModule["PrismaClient"]>;

  let campusId: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    const { PrismaClient } = await import("@prisma/client");
    const { softDeleteExtension } = await import("@/lib/prisma-soft-delete");
    basePrisma = new PrismaClient({
      datasources: { db: { url: integrationDatabaseUrl } },
    });
    await basePrisma.$connect();
    prisma = basePrisma.$extends(softDeleteExtension) as unknown as InstanceType<
      PrismaModule["PrismaClient"]
    >;

    const campus = await basePrisma.campus.create({
      data: {
        name: "软删除集成测试校区",
        slug: `it-softdel-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        schoolName: "集成测试大学",
      },
    });
    campusId = campus.id;
  });

  afterAll(async () => {
    // 物理清理：显式 deletedAt 豁免路径删除用户，再删校区
    if (campusId) {
      await basePrisma.user.deleteMany({
        where: { campusId, OR: [{ deletedAt: { not: null } }, { deletedAt: null }] },
      });
      await basePrisma.campus.delete({ where: { id: campusId } });
    }
    await basePrisma.$disconnect();
  });

  async function createUser(name: string): Promise<string> {
    const user = await prisma.user.create({
      data: {
        name,
        email: `it-softdel-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`,
        passwordHash: "x",
        schoolName: "集成测试大学",
        campusId,
      },
    });
    userIds.push(user.id);
    return user.id;
  }

  it("single delete 软删除：deletedAt 打标而非物理删除", async () => {
    const id = await createUser("单删");
    const before = await basePrisma.user.findUnique({ where: { id } });
    expect(before).not.toBeNull();

    await prisma.user.delete({ where: { id } });

    // 带扩展的客户端视为不存在；裸客户端确认行仍在且打了标记
    await expect(prisma.user.findUnique({ where: { id } })).resolves.toBeNull();
    const raw = await basePrisma.user.findUnique({ where: { id } });
    expect(raw?.deletedAt).not.toBeNull();
  });

  it("deleteMany 批量软删除：全部打标，不抛 PrismaClientValidationError", async () => {
    const a = await createUser("批删A");
    const b = await createUser("批删B");

    const result = await prisma.user.deleteMany({
      where: { campusId, id: { in: [a, b] } },
    });
    expect(result.count).toBe(2);

    const raws = await basePrisma.user.findMany({ where: { id: { in: [a, b] } } });
    expect(raws).toHaveLength(2);
    for (const raw of raws) {
      expect(raw.deletedAt).not.toBeNull();
    }
  });

  it("默认查询排除已软删除行；显式 deletedAt 条件可查询到", async () => {
    const id = await createUser("可见性");
    await prisma.user.delete({ where: { id } });

    const visible = await prisma.user.findMany({ where: { campusId, id } });
    expect(visible).toHaveLength(0);

    const explicit = await prisma.user.findMany({
      where: { campusId, id, deletedAt: { not: null } },
    });
    expect(explicit).toHaveLength(1);
  });

  it("显式 deletedAt 条件的 deleteMany 仍为物理删除", async () => {
    const id = await createUser("物删");
    await prisma.user.delete({ where: { id } });

    const result = await prisma.user.deleteMany({
      where: { id, deletedAt: { not: null } },
    });
    expect(result.count).toBe(1);

    const raw = await basePrisma.user.findUnique({ where: { id } });
    expect(raw).toBeNull();
  });

  it("事务内的 deleteMany 同样走软删除", async () => {
    const id = await createUser("事务");

    await prisma.$transaction(async (tx) => {
      await tx.user.deleteMany({ where: { id } });
    });

    const raw = await basePrisma.user.findUnique({ where: { id } });
    expect(raw?.deletedAt).not.toBeNull();
  });

  it("重复软删除幂等：第二次 deleteMany 命中 0 行，状态不变", async () => {
    const id = await createUser("幂等");
    await prisma.user.delete({ where: { id } });
    const first = await basePrisma.user.findUnique({ where: { id } });

    const again = await prisma.user.deleteMany({ where: { id } });
    expect(again.count).toBe(0);

    const second = await basePrisma.user.findUnique({ where: { id } });
    expect(second?.deletedAt?.getTime()).toBe(first?.deletedAt?.getTime());
  });
});
