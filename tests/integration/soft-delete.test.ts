import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 软删除扩展真实 PostgreSQL 合同（PRISMA-SOFT-DELETE-IMPL-01，fail closed）。
 *
 * 旧合同（透明 delete→update/deleteMany→updateMany 改写）已废弃：其中
 * "事务内的 deleteMany 同样走软删除"用例在旧架构下实际固化了 root client
 * 事务逃逸（改写经 defineExtension 闭包以 autocommit 执行），随 fail-closed
 * 边界一并删除。
 *
 * 新 mutation 合同：经扩展业务客户端对软删除模型调用 delete/deleteMany 一律
 * 拒绝（SOFT_DELETE_EXPLICIT_DOMAIN_MUTATION_REQUIRED），且**不存在**显式
 * deletedAt 豁免——物理清理不经业务扩展客户端（生产 PHYSICAL_PURGE_CALLERS=0；
 * 测试基建使用裸 PrismaClient，不受本合同约束）。
 *
 * 门禁：
 *  SD-GUARD-PG01: extendedClient.user.delete → reject → raw 行仍在、deletedAt 仍 null
 *  SD-GUARD-PG02: extendedClient.user.deleteMany → reject → 全部行仍在、deletedAt 仍 null
 *  SD-GUARD-PG03: ITX 内 tx.user.delete → reject → 事务零副作用
 *  SD-GUARD-PG04: ITX 内 tx.user.deleteMany → reject → 事务零副作用
 *  SD-GUARD-PG05: 软删除行被 extended findUnique 隐藏（read filter 回归）
 *  SD-GUARD-PG06: 软删除行被 extended findMany 隐藏；显式 deletedAt 查询可见
 *
 * fixture 约束：软删除行一律经 base client update({ data: { deletedAt } }) 构造
 * ——那是测试 fixture，不是生产 mutation API（fail-closed 后扩展客户端已无
 * 合法软删除入口，这正是合同本身）。
 */

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

describe.skipIf(!integrationDatabaseUrl)("软删除扩展 fail-closed 合同 (real PG)", () => {
  type PrismaModule = typeof import("@prisma/client");
  let basePrisma: InstanceType<PrismaModule["PrismaClient"]>;
  let prisma: InstanceType<PrismaModule["PrismaClient"]>;

  let campusId: string;

  beforeAll(async () => {
    const { PrismaClient } = await import("@prisma/client");
    const { softDeleteExtension } = await import("@/lib/prisma-soft-delete");
    basePrisma = new PrismaClient({
      datasources: { db: { url: integrationDatabaseUrl } },
    });
    await basePrisma.$connect();
    // $extends 的泛型重载导致返回类型无法直接命名，这里以基础 client 类型承载
    prisma = basePrisma.$extends(softDeleteExtension) as unknown as InstanceType<
      PrismaModule["PrismaClient"]
    >;

    const campus = await basePrisma.campus.create({
      data: {
        name: "软删除 fail-closed 合同校区",
        slug: `it-sdfc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        schoolName: "集成测试大学",
      },
    });
    campusId = campus.id;
  }, 60_000);

  afterAll(async () => {
    // 清场走 base client：未挂扩展 = 真实物理删除（不属于业务 extended 客户端语义域）
    if (campusId) {
      await basePrisma.user.deleteMany({ where: { campusId } });
      await basePrisma.campus.delete({ where: { id: campusId } });
    }
    await basePrisma.$disconnect();
  });

  let userSeq = 0;

  async function createUser(name: string) {
    const user = await basePrisma.user.create({
      data: {
        name,
        email: `it-sdfc-${name}-${Date.now()}-${(userSeq += 1)}-${Math.random()
          .toString(36)
          .slice(2, 6)}@test.local`,
        passwordHash: "x",
        schoolName: "集成测试大学",
        campusId,
      },
    });
    return user;
  }

  async function rawUser(id: string) {
    return basePrisma.user.findUnique({ where: { id } });
  }

  it("SD-GUARD-PG01: extended delete rejects; raw row survives with deletedAt null", async () => {
    const user = await createUser("pg01");

    await expect(prisma.user.delete({ where: { id: user.id } })).rejects.toMatchObject({
      code: "SOFT_DELETE_EXPLICIT_DOMAIN_MUTATION_REQUIRED",
    });

    const raw = await rawUser(user.id);
    expect(raw).not.toBeNull();
    expect(raw?.deletedAt).toBeNull();
  });

  it("SD-GUARD-PG02: extended deleteMany rejects; all rows survive with deletedAt null", async () => {
    const a = await createUser("pg02a");
    const b = await createUser("pg02b");

    await expect(
      prisma.user.deleteMany({ where: { campusId, id: { in: [a.id, b.id] } } }),
    ).rejects.toMatchObject({ code: "SOFT_DELETE_EXPLICIT_DOMAIN_MUTATION_REQUIRED" });

    const raws = await basePrisma.user.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(raws).toHaveLength(2);
    for (const raw of raws) {
      expect(raw.deletedAt).toBeNull();
    }
  });

  it("SD-GUARD-PG03: tx.user.delete inside ITX rejects with zero side effects", async () => {
    const user = await createUser("pg03");

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.user.delete({ where: { id: user.id } });
      }),
    ).rejects.toMatchObject({ code: "SOFT_DELETE_EXPLICIT_DOMAIN_MUTATION_REQUIRED" });

    const raw = await rawUser(user.id);
    expect(raw).not.toBeNull();
    expect(raw?.deletedAt).toBeNull();
  });

  it("SD-GUARD-PG04: tx.user.deleteMany inside ITX rejects with zero side effects", async () => {
    const a = await createUser("pg04a");
    const b = await createUser("pg04b");

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.user.deleteMany({ where: { campusId, id: { in: [a.id, b.id] } } });
      }),
    ).rejects.toMatchObject({ code: "SOFT_DELETE_EXPLICIT_DOMAIN_MUTATION_REQUIRED" });

    const raws = await basePrisma.user.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(raws).toHaveLength(2);
    for (const raw of raws) {
      expect(raw.deletedAt).toBeNull();
    }
  });

  it("SD-GUARD-PG05: extended findUnique hides soft-deleted rows (read filter regression)", async () => {
    // fixture 经 base client update 打标——扩展客户端已无合法软删除入口
    const user = await createUser("pg05");
    await basePrisma.user.update({
      where: { id: user.id },
      data: { deletedAt: new Date() },
    });

    await expect(prisma.user.findUnique({ where: { id: user.id } })).resolves.toBeNull();
    // findUniqueOrThrow 同样按"不存在"处理
    await expect(prisma.user.findUniqueOrThrow({ where: { id: user.id } })).rejects.toMatchObject({
      code: "P2025",
    });
  });

  it("SD-GUARD-PG06: extended findMany hides soft-deleted rows; explicit deletedAt inspects them", async () => {
    const live = await createUser("pg06live");
    const deleted = await createUser("pg06del");
    await basePrisma.user.update({
      where: { id: deleted.id },
      data: { deletedAt: new Date() },
    });

    // 默认读取隐藏已删除行
    const visible = await prisma.user.findMany({
      where: { campusId, id: { in: [live.id, deleted.id] } },
      select: { id: true },
    });
    expect(visible).toEqual([{ id: live.id }]);

    // 显式 deletedAt 查询仍可检视软删除行（read side 豁免保持不变）
    const explicit = await prisma.user.findFirst({
      where: { id: deleted.id, deletedAt: { not: null } },
      select: { id: true, deletedAt: true },
    });
    expect(explicit?.id).toBe(deleted.id);
    expect(explicit?.deletedAt).not.toBeNull();
  });
});
