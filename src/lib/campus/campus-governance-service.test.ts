import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  withTransactionMock,
  acquireGovernanceSubjectLocks,
  loadAuthorizationContext,
  requirePermissionInContext,
  recordAdminAudit,
  campusCreate,
  campusFindUnique,
  campusUpdate,
} = vi.hoisted(() => ({
  withTransactionMock: vi.fn(),
  acquireGovernanceSubjectLocks: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  requirePermissionInContext: vi.fn(),
  recordAdminAudit: vi.fn(),
  campusCreate: vi.fn(),
  campusFindUnique: vi.fn(),
  campusUpdate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
  withTransaction: withTransactionMock,
}));

vi.mock("@/lib/governance/governance-lock", () => ({
  acquireGovernanceSubjectLocks,
}));

vi.mock("@/lib/rbac/service", () => ({
  loadAuthorizationContext,
  requirePermissionInContext,
}));

vi.mock("@/lib/governance/admin-audit", () => ({ recordAdminAudit }));

import { Prisma } from "@prisma/client";
import {
  activateGovernanceCampus,
  createGovernanceCampus,
  deactivateGovernanceCampus,
  updateGovernanceCampusMetadata,
} from "@/lib/campus/campus-governance-service";

const txStub = {
  campus: {
    create: campusCreate,
    findUnique: campusFindUnique,
    update: campusUpdate,
  },
} as unknown as Prisma.TransactionClient;

const ACTOR = "actor-1";
const CAMPUS_ID = "campus-a";

const AUTH_CONTEXT = {
  userId: ACTOR,
  accountActive: true,
  activeCampusIds: [],
  grants: [],
};

beforeEach(() => {
  for (const mock of [
    withTransactionMock,
    acquireGovernanceSubjectLocks,
    loadAuthorizationContext,
    requirePermissionInContext,
    recordAdminAudit,
    campusCreate,
    campusFindUnique,
    campusUpdate,
  ]) {
    mock.mockReset();
  }
  withTransactionMock.mockImplementation(
    async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => callback(txStub),
  );
  acquireGovernanceSubjectLocks.mockResolvedValue(undefined);
  loadAuthorizationContext.mockResolvedValue(AUTH_CONTEXT);
  requirePermissionInContext.mockResolvedValue(undefined);
  recordAdminAudit.mockResolvedValue(undefined);
  campusCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: CAMPUS_ID,
    name: data.name,
    slug: data.slug,
    schoolName: data.schoolName,
    district: data.district ?? null,
    isActive: data.isActive ?? true,
    createdAt: new Date(),
  }));
  campusFindUnique.mockResolvedValue({
    id: CAMPUS_ID,
    name: "主校区",
    slug: "main-campus",
    schoolName: "示例大学",
    district: null,
    isActive: false,
    createdAt: new Date(),
  });
  campusUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: CAMPUS_ID,
    isActive: data.isActive ?? false,
  }));
});

describe("createGovernanceCampus（§26）", () => {
  it("GLOBAL campus.manage 锁链下创建：USER:actor 锁 → 锁定授权重读 → isActive=true 创建 + audit", async () => {
    const campus = await createGovernanceCampus({
      actorId: ACTOR,
      name: " 主校区 ",
      slug: "main-campus",
      schoolName: "示例大学",
      district: "海淀区",
    });

    expect(acquireGovernanceSubjectLocks).toHaveBeenCalledWith(txStub, [
      { subjectType: "USER", subjectId: ACTOR },
    ]);
    expect(loadAuthorizationContext).toHaveBeenCalledWith(ACTOR, txStub);
    expect(requirePermissionInContext).toHaveBeenCalledWith(AUTH_CONTEXT, "campus.manage");
    expect(campusCreate).toHaveBeenCalledWith({
      data: {
        name: "主校区",
        slug: "main-campus",
        schoolName: "示例大学",
        district: "海淀区",
        isActive: true,
      },
    });
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "CAMPUS_CREATED", targetType: "CAMPUS", campusId: CAMPUS_ID }),
      txStub,
    );
    expect(campus.isActive).toBe(true);
  });

  it("slug 非法（大写/空/首尾连字符）→ CAMPUS_SLUG_INVALID，零锁零查询", async () => {
    for (const bad of ["Main-Campus", "", "-main-", "main--campus", "主校区"]) {
      await expect(
        createGovernanceCampus({ actorId: ACTOR, name: "主校区", slug: bad, schoolName: "示例大学" }),
      ).rejects.toMatchObject({ code: "CAMPUS_SLUG_INVALID" });
    }
    expect(acquireGovernanceSubjectLocks).not.toHaveBeenCalled();
    expect(campusCreate).not.toHaveBeenCalled();
  });

  it("name/schoolName 为空 → CAMPUS_INPUT_INVALID", async () => {
    await expect(
      createGovernanceCampus({ actorId: ACTOR, name: "  ", slug: "main-campus", schoolName: "示例大学" }),
    ).rejects.toMatchObject({ code: "CAMPUS_INPUT_INVALID" });
    await expect(
      createGovernanceCampus({ actorId: ACTOR, name: "主校区", slug: "main-campus", schoolName: "" }),
    ).rejects.toMatchObject({ code: "CAMPUS_INPUT_INVALID" });
  });

  it("C-RACE-05 单元语义：slug unique 冲突（P2002）→ 稳定机器码 CAMPUS_SLUG_CONFLICT（绝不静默改后缀）", async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
      meta: { target: ["slug"] },
    });
    campusCreate.mockRejectedValue(conflict);

    await expect(
      createGovernanceCampus({ actorId: ACTOR, name: "主校区", slug: "main-campus", schoolName: "示例大学" }),
    ).rejects.toMatchObject({ code: "CAMPUS_SLUG_CONFLICT" });
  });

  it("非 slug 冲突的未知错误原样抛出（不吞错）", async () => {
    campusCreate.mockRejectedValue(new Error("boom"));

    await expect(
      createGovernanceCampus({ actorId: ACTOR, name: "主校区", slug: "main-campus", schoolName: "示例大学" }),
    ).rejects.toThrow("boom");
  });
});

describe("updateGovernanceCampusMetadata（§27：slug 结构性不可变）", () => {
  it("USER:actor + CAMPUS:<id> 双锁 → 授权重读 → 仅更新提供的元数据字段 + audit", async () => {
    await updateGovernanceCampusMetadata({
      actorId: ACTOR,
      campusId: CAMPUS_ID,
      name: "新名称",
      schoolName: "新学校",
      district: null,
    });

    expect(acquireGovernanceSubjectLocks).toHaveBeenCalledWith(txStub, [
      { subjectType: "USER", subjectId: ACTOR },
      { subjectType: "CAMPUS", subjectId: CAMPUS_ID },
    ]);
    expect(campusUpdate).toHaveBeenCalledWith({
      where: { id: CAMPUS_ID },
      data: { name: "新名称", schoolName: "新学校", district: null },
    });
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "CAMPUS_UPDATED", campusId: CAMPUS_ID }),
      txStub,
    );
  });

  it("update data 结构性不含 slug/id/createdAt（§21 slug IMMUTABLE）", async () => {
    await updateGovernanceCampusMetadata({
      actorId: ACTOR,
      campusId: CAMPUS_ID,
      name: "新名称",
    });

    const data = campusUpdate.mock.calls[0][0].data as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(["name"]);
  });

  it("零字段 → 幂等 no-op（无 mutation 即无 audit）", async () => {
    const campus = await updateGovernanceCampusMetadata({ actorId: ACTOR, campusId: CAMPUS_ID });

    expect(campusUpdate).not.toHaveBeenCalled();
    expect(recordAdminAudit).not.toHaveBeenCalled();
    expect(campus).toMatchObject({ id: CAMPUS_ID });
  });

  it("CA05：campus 不存在 → CAMPUS_NOT_FOUND（先锁与授权，后存在性）", async () => {
    campusFindUnique.mockResolvedValue(null);

    await expect(
      updateGovernanceCampusMetadata({ actorId: ACTOR, campusId: "ghost", name: "X" }),
    ).rejects.toMatchObject({ code: "CAMPUS_NOT_FOUND" });
    expect(campusUpdate).not.toHaveBeenCalled();
  });

  it("CA04：授权重读失败（账号停用/权限被撤）→ fail closed，零 mutation 零 audit", async () => {
    requirePermissionInContext.mockRejectedValue(new Error("AUTH_PERMISSION_DENIED"));

    await expect(
      updateGovernanceCampusMetadata({ actorId: ACTOR, campusId: CAMPUS_ID, name: "X" }),
    ).rejects.toThrow("AUTH_PERMISSION_DENIED");
    expect(campusUpdate).not.toHaveBeenCalled();
    expect(recordAdminAudit).not.toHaveBeenCalled();
  });
});

describe("activate / deactivateGovernanceCampus（§28 same-state 幂等）", () => {
  it("CA07：same-state 激活（已启用）→ 幂等原样返回，零 mutation 零 audit", async () => {
    campusFindUnique.mockResolvedValue({
      id: CAMPUS_ID,
      name: "主校区",
      slug: "main-campus",
      schoolName: "示例大学",
      district: null,
      isActive: true,
      createdAt: new Date(),
    });

    const campus = await activateGovernanceCampus({ actorId: ACTOR, campusId: CAMPUS_ID });

    expect(campusUpdate).not.toHaveBeenCalled();
    expect(recordAdminAudit).not.toHaveBeenCalled();
    expect(campus.isActive).toBe(true);
  });

  it("CA08：deactivate 迁移 isActive false + 机器字段 audit（previousIsActive/newIsActive）", async () => {
    campusFindUnique.mockResolvedValue({
      id: CAMPUS_ID,
      name: "主校区",
      slug: "main-campus",
      schoolName: "示例大学",
      district: null,
      isActive: true,
      createdAt: new Date(),
    });

    const campus = await deactivateGovernanceCampus({ actorId: ACTOR, campusId: CAMPUS_ID });

    expect(campusUpdate).toHaveBeenCalledWith({
      where: { id: CAMPUS_ID },
      data: { isActive: false },
    });
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CAMPUS_DEACTIVATED",
        campusId: CAMPUS_ID,
        metadata: { previousIsActive: true, newIsActive: false },
      }),
      txStub,
    );
    expect(campus.isActive).toBe(false);
  });

  it("activate 迁移 isActive true + audit CAMPUS_ACTIVATED", async () => {
    await activateGovernanceCampus({ actorId: ACTOR, campusId: CAMPUS_ID });

    expect(campusUpdate).toHaveBeenCalledWith({
      where: { id: CAMPUS_ID },
      data: { isActive: true },
    });
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CAMPUS_ACTIVATED",
        metadata: { previousIsActive: false, newIsActive: true },
      }),
      txStub,
    );
  });

  it("campus 不存在 → CAMPUS_NOT_FOUND", async () => {
    campusFindUnique.mockResolvedValue(null);

    await expect(
      deactivateGovernanceCampus({ actorId: ACTOR, campusId: "ghost" }),
    ).rejects.toMatchObject({ code: "CAMPUS_NOT_FOUND" });
  });
});
