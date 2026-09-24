import { randomUUID } from "node:crypto";
import { hash } from "bcryptjs";
import type { Prisma } from "@prisma/client";

import { governanceError } from "@/lib/governance/domain-errors";
import { acquireGovernanceSubjectLock } from "@/lib/governance/governance-lock";
import { logger } from "@/lib/logger";
import { withTransaction } from "@/lib/prisma";
import { assertNoActiveHold } from "@/lib/privacy/data-hold-service";
import { ERASED_USER_CONTENT_MARKER } from "@/lib/privacy/privacy-data-registry";

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

/** 仍在处理中的支持工单状态（存在即阻断注销；terminal 不阻断） */
const ACTIVE_SUPPORT_TICKET_STATUSES = ["OPEN", "IN_PROGRESS"] as const;

/** 支持工单自由文本的注销匿名化标记（ERASED_USER_CONTENT_MARKER 同一惯例） */
export const ERASED_SUPPORT_TICKET_TEXT_MARKER = ERASED_USER_CONTENT_MARKER;

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
  /** 敏感资产（头像/认证/交接/归还/举报材料）已标记 PENDING_DELETE，由既有 storage:cleanup 物理删除 */
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

    // Phase 7G：active 支持工单（OPEN/IN_PROGRESS）阻断注销。已持有
    // USER:<requester> subject 锁——与 createSupportTicket / claim / resolve
    // 同锁串行（S-RACE 线性化合同）：工单创建/终局要么整体先于本检查提交
    // （必见），要么被推迟到本事务提交之后（届时其锁内 account recheck
    // / 状态机断言 fail closed）。terminal（RESOLVED/CLOSED）不阻断。
    const activeSupportTicketCount = await client.supportTicket.count({
      where: {
        requesterId: userId,
        status: { in: [...ACTIVE_SUPPORT_TICKET_STATUSES] },
      },
    });

    if (activeSupportTicketCount > 0) {
      logger.warn("account_erasure_blocked", "privacy", {
        subjectId: userId,
        reasonCode: "ACTIVE_SUPPORT_TICKET",
      });
      throw governanceError("ACTIVE_SUPPORT_TICKET");
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
        // R4-01：schoolName 非空列（registry=DIRECT_IDENTITY/REDACT）——
        // 哨兵替换而非置 null
        schoolName: ERASED_USER_DISPLAY_NAME,
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

    // Phase 6A：成员关系闭环为 LEFT（subject 锁已持有，与认证决定/角色变更
    // 同一把锁串行化——不存在"已注销账号之后获得/保持生效成员身份"）
    await client.campusMembership.updateMany({
      where: { userId, status: { not: "LEFT" } },
      data: { status: "LEFT" },
    });

    // Repair 4 / RB-40（REVIEW FIX R4-03 §10/§18 扩展）：全部 8 类业务镜像
    // 资产（含 PUBLIC 的 PRODUCT/SERVICE/RENTAL listing 图）在 owner 注销时
    // 一律进入 durable deletion queue——public/private 不改变 erasure
    // lifecycle。UPLOADING 行绝不直接切 PENDING_DELETE——外部 S3 PUT 可能
    // 尚在进行，cleanup 与 PUT 存在对象复活 race；UPLOADING 保持既有
    // stale-upload TTL 恢复合同（RECOVERABLE_STAGING：最终无法 attach +
    // cleanup 必然收敛删除）。
    const sensitiveAssets = await client.uploadedAsset.updateMany({
      where: {
        ownerId: userId,
        category: {
          in: [
            "AVATAR",
            "VERIFICATION",
            "HANDOVER",
            "RETURN",
            "REPORT",
            "PRODUCT",
            "SERVICE",
            "RENTAL",
          ],
        },
        status: { in: ["UPLOADED", "ATTACHED"] },
      },
      data: { status: "PENDING_DELETE" },
    });

    // Repair 4 / RB-43：originalFileName 是潜在 PII——本人全部资产
    // （任意 category / access / 状态）统一清空；bucket/objectKey 内部定位符
    // 保留（physical cleanup 仍需要）。
    await client.uploadedAsset.updateMany({
      where: { ownerId: userId, originalFileName: { not: null } },
      data: { originalFileName: null },
    });

    // Repair 4 / RB-23：Notification 是 derived ephemeral inbox——注销后无
    // 保留必要，整表删除（在 erasure 事务内）。
    await client.notification.deleteMany({ where: { userId } });

    // Repair 4 / RB-24：本人发送的消息保留行（conversation/report 关系历史
    // 不破坏），但 free text 置哨兵标记 + sender 置空（schema senderId 可空）。
    await client.message.updateMany({
      where: { senderId: userId },
      data: { content: ERASED_USER_CONTENT_MARKER, senderId: null },
    });

    // Repair 4 / RB-25：本人 authored 评价保留结构（rating/order/target/
    // 时间；authorId 继续 refer pseudonymous User row），文本与标签清空。
    await client.review.updateMany({
      where: { authorId: userId },
      data: { content: null, tags: [] },
    });

    await client.rentalReview.updateMany({
      where: { authorId: userId },
      data: { content: null, tags: [] },
    });

    // Repair 4 / RB-26：本人 filed 举报的 detail（user free text）清空；
    // reason 枚举 / status / scope provenance / decision history 保留。
    // handledNote 属 operator/governance（RETAIN_GOVERNANCE，不清）。
    await client.report.updateMany({
      where: { reporterId: userId },
      data: { detail: null },
    });

    // Repair 4 / RB-27：本人作为 appellant 的申诉——statement 是
    // user-authored content（非空列 → 哨兵标记）；status/decision 机器记录
    // 保留；decisionNote 属 OPERATOR_ONLY（不清，也永不 self-export）。
    await client.appeal.updateMany({
      where: { enforcementAction: { targetId: userId } },
      data: { statement: ERASED_USER_CONTENT_MARKER },
    });

    // Repair 4 / RB-28：General Order 无可靠 cancelledBy attribution——参与者
    // 任一方注销即清双方可见的歧义 free text（隐私侧优先）；amount/status/
    // type/timestamps 等交易结构历史保留。
    await client.order.updateMany({
      where: { OR: [{ buyerId: userId }, { sellerId: userId }] },
      data: { note: null, cancelReason: null },
    });

    // Repair 4 / RB-29：租赁订单 free text 按精确作者归属清理；
    // cancellationReason 枚举是机器类别（非 raw free text），保留。
    await client.rentalOrder.updateMany({
      where: { renterId: userId, renterNote: { not: null } },
      data: { renterNote: null },
    });

    await client.rentalOrder.updateMany({
      where: { cancelledById: userId, cancellationNote: { not: null } },
      data: { cancellationNote: null },
    });

    // Repair 4 / RB-30：本人写入的状态流转日志 note 清空（未来写入侧已
    // 冻结"只允许 system-generated description"）；fromStatus/toStatus/
    // operator 伪名引用/时间保留。
    await client.rentalOrderStatusLog.updateMany({
      where: { operatorId: userId, note: { not: null } },
      data: { note: null },
    });

    // Repair 4 / RB-31：本人发起的纠纷（active dispute 已被前置检查阻断，
    // 此处只可能是 terminal）——reason/evidencePhotos 清理，evidence 资产
    // 已由上方 REPORT category PENDING_DELETE 收敛；status/resolution
    // 机器记录与 adminNote（OPERATOR_ONLY，governance）保留。
    await client.rentalDispute.updateMany({
      where: { initiatorId: userId },
      data: { reason: ERASED_USER_CONTENT_MARKER, evidencePhotos: [] },
    });

    // ---- Repair 4 REVIEW FIX（R4-03）：listing / order 附属 user-authored
    // 内容。STRUCTURAL ROW RETENTION != USER CONTENT RETENTION：行与结构
    // 元数据保留（OFFLINE/CANCELLED 已由上方下架语句处理），自由文本与
    // 资产引用按唯一 actor 归属清理。registry 分类与执行逐字段对应
    // （LISTING_USER_CONTENT_FIELD_POLICIES / REGISTRY-05）。

    // BlockedUser：blocker==注销人 → reason 置空；relation 行保持现有行为
    await client.blockedUser.updateMany({
      where: { blockerId: userId, reason: { not: null } },
      data: { reason: null },
    });

    // ErrandTask：publisher 唯一作者。description 非空列 → REDACT marker；
    // contactNote 可空 → CLEAR
    await client.errandTask.updateMany({
      where: { publisherId: userId },
      data: { description: ERASED_USER_CONTENT_MARKER, contactNote: null },
    });

    // Product：seller 唯一作者。description 非空 → REDACT；图片为附属
    // ProductImage 内容行（随 listing 行保留的 structural history 之外，
    // 行级 CLEAR = 删除内容行）；受控资产已由上方 PRODUCT 类 PENDING_DELETE
    await client.product.updateMany({
      where: { sellerId: userId },
      data: { description: ERASED_USER_CONTENT_MARKER },
    });

    await client.productImage.deleteMany({
      where: { product: { sellerId: userId } },
    });

    // ServiceListing：provider 唯一作者。description 非空 → REDACT；
    // coverImageUrl 可空 → CLEAR
    await client.serviceListing.updateMany({
      where: { providerId: userId },
      data: { description: ERASED_USER_CONTENT_MARKER, coverImageUrl: null },
    });

    // RentalListing：owner 唯一作者。description 非空 → REDACT；图片为
    // RentalListingImage 内容行（行级 CLEAR）
    await client.rentalListing.updateMany({
      where: { ownerId: userId },
      data: { description: ERASED_USER_CONTENT_MARKER },
    });

    await client.rentalListingImage.deleteMany({
      where: { rentalListing: { ownerId: userId } },
    });

    // RentalDamageClaim（active 义务已阻断注销，此处只可能 terminal）：
    // damageDescription/photos 按 submittedById（owner-only 写入路径）
    // 归属；renterNote 按 order.renterId 归属
    await client.rentalDamageClaim.updateMany({
      where: { submittedById: userId },
      data: { damageDescription: ERASED_USER_CONTENT_MARKER, photos: [] },
    });

    await client.rentalDamageClaim.updateMany({
      where: { order: { renterId: userId }, renterNote: { not: null } },
      data: { renterNote: null },
    });

    // RentalExtensionRequest：ownerNote 由 owner（order.ownerId）批准时写入
    await client.rentalExtensionRequest.updateMany({
      where: { order: { ownerId: userId }, ownerNote: { not: null } },
      data: { ownerNote: null },
    });

    // RentalReturnRecord：inspectionNote 由 owner（order.ownerId）验收时写入；
    // photos 为双确认覆盖语义的混合归属资产引用（STORAGE_METADATA locator，
    // 对象由 HANDOVER/RETURN 资产 lifecycle 物理删除）——不清数组
    await client.rentalReturnRecord.updateMany({
      where: { order: { ownerId: userId }, inspectionNote: { not: null } },
      data: { inspectionNote: null },
    });

    // RentalUnavailablePeriod：owner（经 listing FK）管理的不可租时段；
    // reason 置空，structural timing 保留
    await client.rentalUnavailablePeriod.updateMany({
      where: { rentalListing: { ownerId: userId }, reason: { not: null } },
      data: { reason: null },
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

    // Phase 7G：支持工单自由文本清理（terminal 工单不阻断注销，但 user
    // free text 必须清除）。保留行级 provenance：ticket id / category /
    // status / scope / timestamps；subject/description → 匿名化标记，
    // resolutionMessage/internalNote → null（字段分离冻结下两类文本均为
    // user/operator free text，注销即清）。
    await client.supportTicket.updateMany({
      where: { requesterId: userId },
      data: {
        subject: ERASED_SUPPORT_TICKET_TEXT_MARKER,
        description: ERASED_SUPPORT_TICKET_TEXT_MARKER,
        resolutionMessage: null,
        internalNote: null,
      },
    });

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
