import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prepareGovernanceMutationAuthority, withTransaction, tx } = vi.hoisted(() => {
  const adminLogCreate = vi.fn();
  const tx = {
    productCategory: {
      create: vi.fn().mockResolvedValue({ id: "pc-1" }),
      update: vi.fn().mockResolvedValue({ id: "pc-1" }),
    },
    errandCategory: {
      create: vi.fn().mockResolvedValue({ id: "ec-1" }),
      update: vi.fn().mockResolvedValue({ id: "ec-1" }),
    },
    serviceCategory: {
      create: vi.fn().mockResolvedValue({ id: "sc-1" }),
      update: vi.fn().mockResolvedValue({ id: "sc-1" }),
    },
    moderationKeyword: {
      create: vi.fn().mockResolvedValue({ id: "kw-1" }),
      update: vi.fn().mockResolvedValue({ id: "kw-1" }),
    },
    adminLog: {
      create: adminLogCreate,
    },
  };
  return {
    prepareGovernanceMutationAuthority: vi.fn().mockResolvedValue({ userId: "actor-1" }),
    withTransaction: vi.fn(),
    tx,
  };
});

vi.mock("@/lib/governance/governance-mutation-authority", () => ({
  prepareGovernanceMutationAuthority,
}));

// withTransaction 直通同一 mock tx：断言域写与审计都发生在"同一事务客户端"上。
// admin-audit 的独立写分支（无 tx 时 prisma.adminLog.create）在本服务中不可达，
// 一并 stub 以满足模块导入面。
vi.mock("@/lib/prisma", () => ({
  withTransaction: withTransaction,
  prisma: {
    adminLog: {
      create: vi.fn(),
    },
  },
}));

import {
  toggleCategoryStatusInGovernance,
  toggleModerationKeywordStatusInGovernance,
  upsertCategoryInGovernance,
  upsertModerationKeywordInGovernance,
} from "@/lib/governance/admin-configuration-service";

beforeEach(() => {
  withTransaction.mockReset().mockImplementation(
    async (callback: (txClient: Prisma.TransactionClient) => Promise<unknown>) =>
      callback(tx as unknown as Prisma.TransactionClient),
  );
  prepareGovernanceMutationAuthority.mockClear().mockResolvedValue({ userId: "actor-1" });
  tx.adminLog.create.mockReset().mockResolvedValue({});
  for (const table of [
    tx.productCategory,
    tx.errandCategory,
    tx.serviceCategory,
    tx.moderationKeyword,
  ] as const) {
    table.create.mockClear().mockResolvedValue({ id: "row-1" });
    table.update.mockClear().mockResolvedValue({ id: "row-1" });
  }
});

describe("admin-configuration-service (RB-05 canonical governance)", () => {
  describe("upsertCategoryInGovernance", () => {
    it("creates with fresh category.manage authority and audits in the same tx", async () => {
      const result = await upsertCategoryInGovernance({
        actorId: "actor-1",
        kind: "PRODUCT",
        name: "教材资料",
        slug: "books",
        description: "教材与笔记",
        sortOrder: 1,
        isActive: true,
      });

      // 权威判定：USER actor 锁 + fresh category.manage（经 authority helper）
      expect(prepareGovernanceMutationAuthority).toHaveBeenCalledWith(
        tx,
        "actor-1",
        "category.manage",
        undefined,
      );
      expect(tx.productCategory.create).toHaveBeenCalledWith({
        data: {
          name: "教材资料",
          slug: "books",
          description: "教材与笔记",
          sortOrder: 1,
          isActive: true,
        },
      });
      // 审计与域写同一 tx、恰一条（observable contract：create targetId = slug）
      expect(tx.adminLog.create).toHaveBeenCalledTimes(1);
      expect(tx.adminLog.create).toHaveBeenCalledWith({
        data: {
          adminId: "actor-1",
          action: "CREATE_PRODUCT_CATEGORY",
          targetType: "PRODUCT_CATEGORY",
          targetId: "books",
          detail: "教材资料",
          campusId: null,
          result: "SUCCESS",
          metadata: undefined,
        },
      });
      expect(result).toEqual({ categoryId: "row-1", created: true });
    });

    it("updates by categoryId and keeps the update audit contract", async () => {
      await upsertCategoryInGovernance({
        actorId: "actor-1",
        kind: "ERRAND",
        categoryId: "ec-9",
        name: "代取快递",
        slug: "pickup",
        description: null,
        sortOrder: 2,
        isActive: false,
      });

      expect(tx.errandCategory.update).toHaveBeenCalledWith({
        where: { id: "ec-9" },
        data: {
          name: "代取快递",
          slug: "pickup",
          description: null,
          sortOrder: 2,
          isActive: false,
        },
      });
      expect(tx.errandCategory.create).not.toHaveBeenCalled();
      expect(tx.adminLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "UPDATE_ERRAND_CATEGORY",
          targetType: "ERRAND_CATEGORY",
          targetId: "ec-9",
          detail: "代取快递",
        }),
      });
    });

    it("maps each kind to its own table and audit action", async () => {
      await upsertCategoryInGovernance({
        actorId: "actor-1",
        kind: "SERVICE",
        name: "编程辅导",
        slug: "coding",
        description: null,
        sortOrder: 3,
        isActive: true,
      });

      expect(tx.serviceCategory.create).toHaveBeenCalled();
      expect(tx.productCategory.create).not.toHaveBeenCalled();
      expect(tx.adminLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "CREATE_SERVICE_CATEGORY",
          targetType: "SERVICE_CATEGORY",
        }),
      });
    });

    it("writes nothing when fresh authority denies（zero write on authority loss）", async () => {
      prepareGovernanceMutationAuthority.mockRejectedValue(
        Object.assign(new Error("无权执行该操作"), { code: "AUTH_PERMISSION_DENIED" }),
      );

      await expect(
        upsertCategoryInGovernance({
          actorId: "actor-1",
          kind: "PRODUCT",
          name: "x",
          slug: "x",
          description: null,
          sortOrder: 0,
          isActive: true,
        }),
      ).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });

      expect(tx.productCategory.create).not.toHaveBeenCalled();
      expect(tx.adminLog.create).not.toHaveBeenCalled();
    });
  });

  describe("toggleCategoryStatusInGovernance", () => {
    it("updates isActive and audits ENABLE/DISABLE without detail", async () => {
      await toggleCategoryStatusInGovernance({
        actorId: "actor-1",
        kind: "SERVICE",
        categoryId: "sc-2",
        isActive: false,
      });

      expect(prepareGovernanceMutationAuthority).toHaveBeenCalledWith(
        tx,
        "actor-1",
        "category.manage",
        undefined,
      );
      expect(tx.serviceCategory.update).toHaveBeenCalledWith({
        where: { id: "sc-2" },
        data: { isActive: false },
      });
      expect(tx.adminLog.create).toHaveBeenCalledTimes(1);
      expect(tx.adminLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "DISABLE_SERVICE_CATEGORY",
          targetType: "SERVICE_CATEGORY",
          targetId: "sc-2",
          detail: null,
        }),
      });

      await toggleCategoryStatusInGovernance({
        actorId: "actor-1",
        kind: "SERVICE",
        categoryId: "sc-2",
        isActive: true,
      });
      expect(tx.adminLog.create).toHaveBeenLastCalledWith({
        data: expect.objectContaining({ action: "ENABLE_SERVICE_CATEGORY" }),
      });
    });
  });

  describe("upsertModerationKeywordInGovernance", () => {
    it("creates with fresh moderation.keyword.manage authority and createdById = actor", async () => {
      await upsertModerationKeywordInGovernance({
        actorId: "actor-1",
        keyword: "代考",
        targetType: "GLOBAL",
        isEnabled: true,
      });

      expect(prepareGovernanceMutationAuthority).toHaveBeenCalledWith(
        tx,
        "actor-1",
        "moderation.keyword.manage",
        undefined,
      );
      expect(tx.moderationKeyword.create).toHaveBeenCalledWith({
        data: {
          keyword: "代考",
          targetType: "GLOBAL",
          isEnabled: true,
          createdById: "actor-1",
        },
      });
      expect(tx.adminLog.create).toHaveBeenCalledTimes(1);
      expect(tx.adminLog.create).toHaveBeenCalledWith({
        data: {
          adminId: "actor-1",
          action: "CREATE_MODERATION_KEYWORD",
          targetType: "MODERATION_KEYWORD",
          targetId: "代考",
          detail: "GLOBAL",
          campusId: null,
          result: "SUCCESS",
          metadata: undefined,
        },
      });
    });

    it("updates by keywordId and keeps the update audit contract", async () => {
      await upsertModerationKeywordInGovernance({
        actorId: "actor-1",
        keywordId: "kw-9",
        keyword: "更新后的关键词",
        targetType: "MESSAGE",
        isEnabled: false,
      });

      expect(tx.moderationKeyword.update).toHaveBeenCalledWith({
        where: { id: "kw-9" },
        data: { keyword: "更新后的关键词", targetType: "MESSAGE", isEnabled: false },
      });
      expect(tx.moderationKeyword.create).not.toHaveBeenCalled();
      expect(tx.adminLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "UPDATE_MODERATION_KEYWORD",
          targetType: "MODERATION_KEYWORD",
          targetId: "kw-9",
          detail: "MESSAGE",
        }),
      });
    });

    it("writes nothing when fresh authority denies", async () => {
      prepareGovernanceMutationAuthority.mockRejectedValue(
        Object.assign(new Error("无权执行该操作"), { code: "AUTH_PERMISSION_DENIED" }),
      );

      await expect(
        upsertModerationKeywordInGovernance({
          actorId: "actor-1",
          keyword: "代考",
          targetType: "GLOBAL",
          isEnabled: true,
        }),
      ).rejects.toMatchObject({ code: "AUTH_PERMISSION_DENIED" });

      expect(tx.moderationKeyword.create).not.toHaveBeenCalled();
      expect(tx.adminLog.create).not.toHaveBeenCalled();
    });
  });

  describe("toggleModerationKeywordStatusInGovernance", () => {
    it("updates isEnabled and audits ENABLE/DISABLE in the same tx", async () => {
      await toggleModerationKeywordStatusInGovernance({
        actorId: "actor-1",
        keywordId: "kw-1",
        isEnabled: true,
      });

      expect(prepareGovernanceMutationAuthority).toHaveBeenCalledWith(
        tx,
        "actor-1",
        "moderation.keyword.manage",
        undefined,
      );
      expect(tx.moderationKeyword.update).toHaveBeenCalledWith({
        where: { id: "kw-1" },
        data: { isEnabled: true },
      });
      expect(tx.adminLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "ENABLE_MODERATION_KEYWORD",
          targetId: "kw-1",
        }),
      });

      await toggleModerationKeywordStatusInGovernance({
        actorId: "actor-1",
        keywordId: "kw-1",
        isEnabled: false,
      });
      expect(tx.moderationKeyword.update).toHaveBeenLastCalledWith({
        where: { id: "kw-1" },
        data: { isEnabled: false },
      });
      expect(tx.adminLog.create).toHaveBeenLastCalledWith({
        data: expect.objectContaining({ action: "DISABLE_MODERATION_KEYWORD" }),
      });
    });
  });

  describe("audit atomicity seams", () => {
    it("runs beforeAudit between the domain write and the audit write", async () => {
      const order: string[] = [];
      tx.productCategory.create.mockImplementation(async () => {
        order.push("domainWrite");
        return { id: "pc-1" };
      });
      tx.adminLog.create.mockImplementation(async () => {
        order.push("audit");
        return {};
      });

      await upsertCategoryInGovernance({
        actorId: "actor-1",
        kind: "PRODUCT",
        name: "n",
        slug: "s",
        description: null,
        sortOrder: 0,
        isActive: true,
        seams: {
          beforeAudit: async () => {
            order.push("beforeAudit");
          },
        },
      });

      expect(order).toEqual(["domainWrite", "beforeAudit", "audit"]);
    });

    it("rolls back the whole mutation when the audit write fails（no silent audit loss）", async () => {
      // same-tx 合同的单元面：审计失败必须向上抛（触发整体回滚），
      // 禁止 best-effort / .catch(() => undefined)。回滚语义本身由
      // 真实 PostgreSQL 集成测试（CATEGORY/KEYWORD-ATOMIC-01）证明。
      tx.moderationKeyword.create.mockResolvedValue({ id: "kw-1" });
      tx.adminLog.create.mockRejectedValue(new Error("audit write failed"));

      await expect(
        upsertModerationKeywordInGovernance({
          actorId: "actor-1",
          keyword: "代考",
          targetType: "GLOBAL",
          isEnabled: true,
        }),
      ).rejects.toThrow("audit write failed");
    });
  });
});
