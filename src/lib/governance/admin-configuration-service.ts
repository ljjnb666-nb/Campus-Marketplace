import { type ModerationTargetType, type Prisma } from "@prisma/client";

import { withTransaction } from "@/lib/prisma";
import { recordAdminAudit } from "@/lib/governance/admin-audit";
import {
  prepareGovernanceMutationAuthority,
  type GovernanceMutationAuthoritySeams,
} from "@/lib/governance/governance-mutation-authority";

/**
 * RB-05：Category / ModerationKeyword 治理配置的 canonical mutation service。
 *
 * 迁移自 src/actions/admin.ts 的 legacy 裸写路径（requireAdmin 快照 →
 * 裸 Prisma 域写 → 独立 AdminLog 写）后，四类 operation family 统一：
 *
 *   USER actor subject 锁 → fresh permission 复核 → 域写（tx）
 *   → AdminLog 审计（recordAdminAudit, 同一 tx）→ COMMIT
 *
 * 关闭的两个 invariant：
 * - AUTHORITY TOCTOU：授权在锁内 fresh 重建，entry 快照过期（并发
 *   revokeRole 先提交）→ 零写入、零审计。
 * - AUDIT ATOMICITY：域写与审计同一事务；审计失败 = 整体回滚
 *   （# NO AUDIT / NO GOVERNANCE COMMIT），成功 = 审计恰一条。
 *
 * observable contract（本 Repair 冻结，不随迁移改变）：
 * - action/targetType 命名沿用 legacy：{CREATE|UPDATE|ENABLE|DISABLE}_<kind>_CATEGORY
 *   / {CREATE|UPDATE|ENABLE|DISABLE}_MODERATION_KEYWORD
 * - category create 审计 targetId = slug（update/toggle = categoryId），detail = name
 * - keyword create 审计 targetId = keyword（update/toggle = keywordId），detail = targetType
 * - keyword create 的 createdById = fresh-authorized actorId（不信任何表单身份）
 *
 * 并发语义（last-write-wins / slug 唯一性等）不在本 Repair 范围，零变更。
 *
 * seams（仅测试注入；生产一律不传）：
 * - beforeLock / afterCheck：透传 authority helper（race 竞态构造）
 * - beforeAudit：域写后、审计写前挂起（same-tx atomicity 证明）
 */
export type AdminConfigurationMutationSeams = GovernanceMutationAuthoritySeams & {
  beforeAudit?: (tx: Prisma.TransactionClient) => Promise<void>;
};

export type CategoryKind = "PRODUCT" | "ERRAND" | "SERVICE";

export type CategoryUpsertInput = {
  actorId: string;
  kind: CategoryKind;
  categoryId?: string;
  name: string;
  slug: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  seams?: AdminConfigurationMutationSeams;
};

export type CategoryToggleInput = {
  actorId: string;
  kind: CategoryKind;
  categoryId: string;
  isActive: boolean;
  seams?: AdminConfigurationMutationSeams;
};

export type ModerationKeywordUpsertInput = {
  actorId: string;
  keywordId?: string;
  keyword: string;
  targetType: ModerationTargetType;
  isEnabled: boolean;
  seams?: AdminConfigurationMutationSeams;
};

export type ModerationKeywordToggleInput = {
  actorId: string;
  keywordId: string;
  isEnabled: boolean;
  seams?: AdminConfigurationMutationSeams;
};

type CategoryRow = { id: string };

type CategoryPayload = {
  name: string;
  slug: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
};

type CategoryTxTable = {
  create(args: { data: CategoryPayload }): Promise<CategoryRow>;
  update(args: {
    where: { id: string };
    data: CategoryPayload | { isActive: boolean };
  }): Promise<CategoryRow>;
};

function categoryTable(tx: Prisma.TransactionClient, kind: CategoryKind): CategoryTxTable {
  switch (kind) {
    case "PRODUCT":
      return tx.productCategory;
    case "ERRAND":
      return tx.errandCategory;
    case "SERVICE":
      return tx.serviceCategory;
  }
}

/** 新建/更新分类（PRODUCT/ERRAND/SERVICE 三域）。category.manage 为唯一权威。 */
export async function upsertCategoryInGovernance(
  input: CategoryUpsertInput,
): Promise<{ categoryId: string; created: boolean }> {
  return withTransaction(async (tx) => {
    await prepareGovernanceMutationAuthority(
      tx,
      input.actorId,
      "category.manage",
      input.seams,
    );

    const payload: CategoryPayload = {
      name: input.name,
      slug: input.slug,
      description: input.description,
      sortOrder: input.sortOrder,
      isActive: input.isActive,
    };

    const row = input.categoryId
      ? await categoryTable(tx, input.kind).update({
          where: { id: input.categoryId },
          data: payload,
        })
      : await categoryTable(tx, input.kind).create({ data: payload });

    if (input.seams?.beforeAudit) {
      await input.seams.beforeAudit(tx);
    }

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: input.categoryId ? `UPDATE_${input.kind}_CATEGORY` : `CREATE_${input.kind}_CATEGORY`,
        targetType: `${input.kind}_CATEGORY`,
        targetId: input.categoryId ?? input.slug,
        detail: input.name,
      },
      tx,
    );

    return { categoryId: row.id, created: !input.categoryId };
  });
}

/** 启用/停用分类。category.manage 为唯一权威。 */
export async function toggleCategoryStatusInGovernance(
  input: CategoryToggleInput,
): Promise<{ categoryId: string; isActive: boolean }> {
  return withTransaction(async (tx) => {
    await prepareGovernanceMutationAuthority(
      tx,
      input.actorId,
      "category.manage",
      input.seams,
    );

    const row = await categoryTable(tx, input.kind).update({
      where: { id: input.categoryId },
      data: { isActive: input.isActive },
    });

    if (input.seams?.beforeAudit) {
      await input.seams.beforeAudit(tx);
    }

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: input.isActive ? `ENABLE_${input.kind}_CATEGORY` : `DISABLE_${input.kind}_CATEGORY`,
        targetType: `${input.kind}_CATEGORY`,
        targetId: input.categoryId,
      },
      tx,
    );

    return { categoryId: row.id, isActive: input.isActive };
  });
}

/** 新建/更新敏感词。moderation.keyword.manage 为唯一权威。 */
export async function upsertModerationKeywordInGovernance(
  input: ModerationKeywordUpsertInput,
): Promise<{ keywordId: string; created: boolean }> {
  return withTransaction(async (tx) => {
    await prepareGovernanceMutationAuthority(
      tx,
      input.actorId,
      "moderation.keyword.manage",
      input.seams,
    );

    const row = input.keywordId
      ? await tx.moderationKeyword.update({
          where: { id: input.keywordId },
          data: {
            keyword: input.keyword,
            targetType: input.targetType,
            isEnabled: input.isEnabled,
          },
        })
      : await tx.moderationKeyword.create({
          data: {
            keyword: input.keyword,
            targetType: input.targetType,
            isEnabled: input.isEnabled,
            createdById: input.actorId,
          },
        });

    if (input.seams?.beforeAudit) {
      await input.seams.beforeAudit(tx);
    }

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: input.keywordId ? "UPDATE_MODERATION_KEYWORD" : "CREATE_MODERATION_KEYWORD",
        targetType: "MODERATION_KEYWORD",
        targetId: input.keywordId ?? input.keyword,
        detail: input.targetType,
      },
      tx,
    );

    return { keywordId: row.id, created: !input.keywordId };
  });
}

/** 启用/停用敏感词。moderation.keyword.manage 为唯一权威。 */
export async function toggleModerationKeywordStatusInGovernance(
  input: ModerationKeywordToggleInput,
): Promise<{ keywordId: string; isEnabled: boolean }> {
  return withTransaction(async (tx) => {
    await prepareGovernanceMutationAuthority(
      tx,
      input.actorId,
      "moderation.keyword.manage",
      input.seams,
    );

    const row = await tx.moderationKeyword.update({
      where: { id: input.keywordId },
      data: { isEnabled: input.isEnabled },
    });

    if (input.seams?.beforeAudit) {
      await input.seams.beforeAudit(tx);
    }

    await recordAdminAudit(
      {
        actorId: input.actorId,
        action: input.isEnabled ? "ENABLE_MODERATION_KEYWORD" : "DISABLE_MODERATION_KEYWORD",
        targetType: "MODERATION_KEYWORD",
        targetId: input.keywordId,
      },
      tx,
    );

    return { keywordId: row.id, isEnabled: input.isEnabled };
  });
}
