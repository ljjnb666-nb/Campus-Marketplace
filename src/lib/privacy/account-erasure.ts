import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import type { Prisma } from "@prisma/client";

import { governanceError } from "@/lib/governance/domain-errors";
import { acquireGovernanceSubjectLock } from "@/lib/governance/governance-lock";
import { logger } from "@/lib/logger";
import { withTransaction } from "@/lib/prisma";
import { assertNoActiveHold } from "@/lib/privacy/data-hold-service";

/**
 * 账号注销 / 匿名化服务（fail closed）。
 *
 * 目标：
 * - 用户身份停止使用（登录/会话/凭据全部失效）
 * - 个人信息最小化（可识别字段清除或替换为不可反查 surrogate）
 * - 历史交易 referential integrity 保持（保留 pseudonymous userId 行）
 * - 治理证据（举报/纠纷/同意）不被非法破坏
 *
 * 红线：
 * - 绝不 prisma.user.delete()（外键级联会破坏审计与历史完整性）
 * - 匿名 surrogate 不得从原始 PII 派生（如 SHA256(email)）——用随机 id
 * - 所有前置检查在破坏性事务内部、且在取得 subject 治理锁之后执行
 * - 任何阻断条件命中时整体失败，绝不部分擦除
 *
 * Serialization contract（Phase 5 REPAIR）：
 * eraseAccount / createHold / releaseHold 共享同一把 subject advisory lock
 * （governance-lock.ts）。READ COMMITTED 下仅靠"事务内再查 hold"不构成
 * serialization boundary——锁保证 hold 与 erase 严格先后线性化：
 *   1. erase 先取锁 → check 无 hold → 提交 → hold 创建随后发生；
 *   2. hold 先取锁 → 提交 → erase 后取锁 → check 见 hold → BLOCK。
 * 不可能出现"hold 已提交而 erase 未见 hold 即提交"。
 */

/** 仍在履行的订单状态（存在即阻断注销） */
const ACTIVE_ORDER_STATUSES = ["PENDING", "ACCEPTED", "IN_PROGRESS"] as const;

/** 仍在履行的租赁订单状态（存在即阻断注销） */
const ACTIVE_RENTAL_ORDER_STATUSES = [
  "PENDING_APPROVAL",
  "PENDING_PAYMENT",
  "PENDING_PICKUP",
  "PICKED_UP",
  "IN_RENTAL",
  "PENDING_RETURN",
  "PENDING_INSPECTION",
  "OVERDUE",
  "IN_DISPUTE",
] as const;

/** 匿名化后的展示名（RELATIONAL_HISTORY 约定） */
export const ERASED_USER_DISPLAY_NAME = "已注销用户";

/** 不可反查的匿名 email surrogate（.invalid 保留 TLD，永不可达） */
function buildErasedEmail(): string {
  return `erased-${randomUUID()}@erased.invalid`;
}

export type AccountErasureResult = {
  userId: string;
  erasedAt: Date;
  deactivatedListings: {
    products: number;
    errandTasks: number;
    serviceListings: number;
    rentalListings: number;
  };
  /** 敏感资产（认证/交接/举报材料）已标记到期，由既有 storage:cleanup 物理删除 */
  sensitiveAssetsMarkedForDeletion: number;
};

/** 测试 seam：在"已取锁 + 前置检查全部通过"与"首个破坏性写"之间的受控暂停点。 */
export type ErasureRacePoint = (tx: Prisma.TransactionClient) => Promise<void>;

/**
 * 执行账号匿名化。调用方必须已经建立 PrivacyRequest（REQUESTED→IN_PROGRESS）。
 * 前置检查在 subject 治理锁保护下的事务内执行；任何阻断命中时零写回滚。
 */
export async function eraseAccount(
  userId: string,
  tx?: Prisma.TransactionClient,
  racePoint?: ErasureRacePoint,
): Promise<AccountErasureResult> {
  const run = async (client: Prisma.TransactionClient): Promise<AccountErasureResult> => {
    // ---- serialization boundary：先取 subject 治理锁（TOCTOU 关闭点）----
    await acquireGovernanceSubjectLock(client, "USER", userId);

    const user = await client.user.findUnique({
      where: { id: userId },
      select: { id: true, erasedAt: true, deletedAt: true, status: true },
    });

    if (!user || user.deletedAt) {
      throw governanceError("PRIVACY_REQUEST_NOT_FOUND", "账号不存在");
    }
    if (user.erasedAt) {
      throw governanceError("ACCOUNT_ALREADY_DELETED");
    }

    // ---- 前置检查（事务内，TOCTOU 防护） ----
    await assertNoActiveHold(userId, client);

    const activeOrderCount = await client.order.count({
      where: {
        OR: [{ buyerId: userId }, { sellerId: userId }],
        status: { in: [...ACTIVE_ORDER_STATUSES] },
      },
    });

    if (activeOrderCount > 0) {
      logger.warn("account_erasure_blocked", "privacy", {
        subjectId: userId,
        reasonCode: "ACTIVE_TRANSACTION_BLOCK",
      });
      throw governanceError("ACTIVE_TRANSACTION_BLOCK");
    }

    const activeRentalOrderCount = await client.rentalOrder.count({
      where: {
        OR: [{ ownerId: userId }, { renterId: userId }],
        status: { in: [...ACTIVE_RENTAL_ORDER_STATUSES] },
      },
    });

    if (activeRentalOrderCount > 0) {
      logger.warn("account_erasure_blocked", "privacy", {
        subjectId: userId,
        reasonCode: "ACTIVE_TRANSACTION_BLOCK",
      });
      throw governanceError("ACTIVE_TRANSACTION_BLOCK");
    }

    // 测试 seam：锁与全部前置检查之后、首个破坏性写之前（并发 hold 在此
    // 点发起会被 subject 锁阻塞，直到本事务提交/回滚——用于 lock ordering
    // 的真实 PG 竞态测试）。生产路径不传该参数。
    if (racePoint) {
      await racePoint(client);
    }

    // ---- 匿名化（保留行，替换可识别字段） ----
    const erasedAt = new Date();
    // 随机口令哈希：原凭据永不再匹配（不做"删除"，保持字段非空约束）
    const invalidPasswordHash = await hash(randomUUID(), 10);

    await client.user.update({
      where: { id: userId },
      data: {
        erasedAt,
        name: ERASED_USER_DISPLAY_NAME,
        email: buildErasedEmail(),
        passwordHash: invalidPasswordHash,
        avatarUrl: null,
        bio: null,
        phone: null,
        college: null,
        grade: null,
        studentIdLast4: null,
        lastLoginAt: null,
        verificationStatus: "UNVERIFIED",
      },
    });

    // 校园认证材料：清除可识别字段，保留行以维持 uploadedAssets 外键历史。
    // studentCardImage 为非空列，置为哨兵值（指向的资产已标记到期删除）
    await client.userVerification.updateMany({
      where: { userId },
      data: {
        schoolName: ERASED_USER_DISPLAY_NAME,
        campusName: ERASED_USER_DISPLAY_NAME,
        studentIdLast4: "0000",
        studentCardImage: "erased",
        reviewNote: null,
        status: "UNVERIFIED",
      },
    });

    // 敏感私有资产：立即到期 → 既有 storage:cleanup 物理删除对象（Phase 1 机制）
    const sensitiveAssets = await client.uploadedAsset.updateMany({
      where: {
        ownerId: userId,
        category: { in: ["VERIFICATION", "HANDOVER", "RETURN", "REPORT"] },
        status: { in: ["UPLOADED", "ATTACHED"] },
      },
      data: { expiresAt: erasedAt },
    });

    // ---- 交易下架：不留"已注销账号 + 可交易 listing" ----
    const products = await client.product.updateMany({
      where: { sellerId: userId, status: { in: ["ACTIVE", "PAUSED", "RESERVED"] } },
      data: { status: "OFFLINE" },
    });

    const errandTasks = await client.errandTask.updateMany({
      where: { publisherId: userId, status: { in: ["OPEN", "CLAIMED", "IN_PROGRESS"] } },
      data: { status: "CANCELLED" },
    });

    const serviceListings = await client.serviceListing.updateMany({
      where: { providerId: userId, status: { in: ["ACTIVE", "PAUSED", "RESERVED"] } },
      data: { status: "OFFLINE" },
    });

    const rentalListings = await client.rentalListing.updateMany({
      where: {
        ownerId: userId,
        status: { in: ["AVAILABLE", "PAUSED", "FULLY_BOOKED", "PENDING_REVIEW"] },
      },
      data: { status: "OFFLINE" },
    });

    // 会话表吊销（JWT 策略下该表通常为空，此为纵深防御）
    await client.session.deleteMany({ where: { userId } });

    const result: AccountErasureResult = {
      userId,
      erasedAt,
      deactivatedListings: {
        products: products.count,
        errandTasks: errandTasks.count,
        serviceListings: serviceListings.count,
        rentalListings: rentalListings.count,
      },
      sensitiveAssetsMarkedForDeletion: sensitiveAssets.count,
    };

    logger.info("account_erasure_completed", "privacy", {
      userId,
      products: result.deactivatedListings.products,
      errandTasks: result.deactivatedListings.errandTasks,
      serviceListings: result.deactivatedListings.serviceListings,
      rentalListings: result.deactivatedListings.rentalListings,
    });

    return result;
  };

  return tx ? run(tx) : withTransaction(run, { timeout: 20_000 });
}
