import { governanceError, isGovernanceError } from "@/lib/governance/domain-errors";
import { logger } from "@/lib/logger";
import { prisma, withTransaction } from "@/lib/prisma";
import { ERASED_USER_DISPLAY_NAME } from "@/lib/privacy/account-erasure";
import { transitionPrivacyRequest } from "@/lib/privacy/privacy-request-service";

/**
 * 用户数据导出（Phase 5 同步实现；Phase 9 异步化）。
 *
 * 隐私边界（NO_CROSS_USER_EXPORT / NO_SECRET_EXPORT / NO_STORAGE_INTERNAL_LEAK）：
 * - 显式 DTO 白名单，绝不 SELECT * 后直接序列化
 * - 他人数据只允许"必要公共信息 + 最小关系引用"（昵称/ID），绝不包含
 *   email / phone / 认证材料 / 私密资料字段 / 内部治理备注 / 风险元数据
 * - 绝不输出 passwordHash / session token / objectKey / bucket / 内部端点
 * - 软删除扩展自动过滤已删除行；对已注销用户仅展示公共占位表示
 */

/** 导出 payload 的硬性体积上限（同步响应保护；超限显式失败，不静默截断） */
export const EXPORT_MAX_BYTES = 8 * 1024 * 1024;

/** 任何导出载荷都不得出现的键名（测试扫描锁定；新增须先过安全评审） */
export const FORBIDDEN_EXPORT_KEYS = [
  "passwordHash",
  "password",
  "sessionToken",
  "session_token",
  "secret",
  "accessToken",
  "refreshToken",
  "token",
  "authorization",
  "cookie",
  "objectKey",
  "bucket",
  "databaseUrl",
  "redisUrl",
  "presignedUrl",
  "reviewNote",
  "handledNote",
  "adminLog",
  "studentCardImage",
  "NEXTAUTH_SECRET",
] as const;

/** 他人（counterparty）侧允许出现的公共字段白名单（与前台公开资料一致） */
const COUNTERPARTY_PUBLIC_FIELDS = ["id", "name", "avatarUrl"] as const;

export type CounterpartyPublicRef = {
  id: string;
  name: string;
  avatarUrl: string | null;
};

/** 他人引用：仅公共展示字段；已注销账号自然呈现匿名占位表示。 */
function pickCounterparty(
  user: { id: string; name: string; avatarUrl: string | null; erasedAt: Date | null } | null,
): CounterpartyPublicRef | null {
  if (!user) {
    return null;
  }

  const ref: CounterpartyPublicRef = {
    id: user.id,
    name: user.erasedAt ? ERASED_USER_DISPLAY_NAME : user.name,
    avatarUrl: user.erasedAt ? null : user.avatarUrl,
  };

  return Object.fromEntries(
    COUNTERPARTY_PUBLIC_FIELDS.map((field) => [field, ref[field]]),
  ) as CounterpartyPublicRef;
}

export type UserExportPayload = {
  exportedAt: string;
  format: "campus-marketplace.user-export/v1";
  account: {
    id: string;
    name: string;
    email: string;
    schoolName: string;
    campusId: string;
    bio: string | null;
    avatarUrl: string | null;
    college: string | null;
    grade: string | null;
    verificationStatus: string;
    createdAt: string;
  };
  policyAcceptances: Array<{
    documentType: string;
    documentVersion: number;
    documentHash: string;
    source: string;
    acceptedAt: string;
  }>;
  listings: {
    products: Array<{ id: string; title: string; price: string; status: string; createdAt: string }>;
    errandTasks: Array<{ id: string; title: string; reward: string; status: string; createdAt: string }>;
    serviceListings: Array<{ id: string; title: string; price: string; status: string; createdAt: string }>;
    rentalListings: Array<{ id: string; title: string; price: string; status: string; createdAt: string }>;
  };
  orders: Array<{
    id: string;
    orderNo: string;
    type: string;
    status: string;
    amount: string;
    role: "buyer" | "seller";
    counterparty: CounterpartyPublicRef | null;
    createdAt: string;
  }>;
  rentalOrders: Array<{
    id: string;
    orderNumber: string;
    status: string;
    role: "owner" | "renter";
    counterparty: CounterpartyPublicRef | null;
    startTime: string;
    endTime: string;
  }>;
  reviewsWritten: Array<{
    id: string;
    orderId: string;
    rating: number;
    content: string | null;
    target: CounterpartyPublicRef | null;
    createdAt: string;
  }>;
  reportsFiled: Array<{
    id: string;
    targetType: string;
    reason: string;
    status: string;
    targetUser: CounterpartyPublicRef | null;
    createdAt: string;
  }>;
  messagesSent: Array<{
    id: string;
    conversationId: string;
    type: string;
    content: string;
    createdAt: string;
  }>;
  uploadedAssets: Array<{
    id: string;
    category: string;
    access: string;
    status: string;
    sizeBytes: number;
    createdAt: string;
  }>;
  privacyRequests: Array<{
    id: string;
    type: string;
    status: string;
    reasonCode: string | null;
    requestedAt: string;
    completedAt: string | null;
  }>;
};

/**
 * 构建当前用户的导出载荷。只能由服务端以已认证用户身份调用；
 * 不接受外部 userId 参数（DATA_EXPORT_FORBIDDEN 留给 API 层误用防御）。
 */
export async function buildUserExport(userId: string): Promise<UserExportPayload> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      schoolName: true,
      campusId: true,
      bio: true,
      avatarUrl: true,
      college: true,
      grade: true,
      verificationStatus: true,
      createdAt: true,
      erasedAt: true,
    },
  });

  if (!user) {
    throw governanceError("DATA_EXPORT_FORBIDDEN");
  }

  if (user.erasedAt) {
    throw governanceError("ACCOUNT_ALREADY_DELETED");
  }

  const [
    acceptances,
    products,
    errandTasks,
    serviceListings,
    rentalListings,
    ordersAsBuyer,
    ordersAsSeller,
    rentalOrdersAsOwner,
    rentalOrdersAsRenter,
    reviewsWritten,
    reportsFiled,
    messagesSent,
    uploadedAssets,
    privacyRequests,
  ] = await Promise.all([
    prisma.policyAcceptance.findMany({
      where: { userId },
      orderBy: { acceptedAt: "asc" },
      select: {
        documentType: true,
        documentVersion: true,
        documentHash: true,
        source: true,
        acceptedAt: true,
      },
    }),
    prisma.product.findMany({
      where: { sellerId: userId },
      orderBy: { createdAt: "asc" },
      select: { id: true, title: true, price: true, status: true, createdAt: true },
    }),
    prisma.errandTask.findMany({
      where: { publisherId: userId },
      orderBy: { createdAt: "asc" },
      select: { id: true, title: true, reward: true, status: true, createdAt: true },
    }),
    prisma.serviceListing.findMany({
      where: { providerId: userId },
      orderBy: { createdAt: "asc" },
      select: { id: true, title: true, price: true, status: true, createdAt: true },
    }),
    prisma.rentalListing.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: "asc" },
      select: { id: true, title: true, price: true, status: true, createdAt: true },
    }),
    prisma.order.findMany({
      where: { buyerId: userId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        orderNo: true,
        type: true,
        status: true,
        amount: true,
        createdAt: true,
        seller: {
          select: { id: true, name: true, avatarUrl: true, erasedAt: true },
        },
      },
    }),
    prisma.order.findMany({
      where: { sellerId: userId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        orderNo: true,
        type: true,
        status: true,
        amount: true,
        createdAt: true,
        buyer: {
          select: { id: true, name: true, avatarUrl: true, erasedAt: true },
        },
      },
    }),
    prisma.rentalOrder.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        startTime: true,
        endTime: true,
        renter: { select: { id: true, name: true, avatarUrl: true, erasedAt: true } },
      },
    }),
    prisma.rentalOrder.findMany({
      where: { renterId: userId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        startTime: true,
        endTime: true,
        owner: { select: { id: true, name: true, avatarUrl: true, erasedAt: true } },
      },
    }),
    prisma.review.findMany({
      where: { authorId: userId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        orderId: true,
        rating: true,
        content: true,
        createdAt: true,
        targetUser: { select: { id: true, name: true, avatarUrl: true, erasedAt: true } },
      },
    }),
    prisma.report.findMany({
      where: { reporterId: userId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        targetType: true,
        reason: true,
        status: true,
        createdAt: true,
        targetUser: { select: { id: true, name: true, avatarUrl: true, erasedAt: true } },
      },
    }),
    prisma.message.findMany({
      where: { senderId: userId },
      orderBy: { createdAt: "asc" },
      select: { id: true, conversationId: true, type: true, content: true, createdAt: true },
    }),
    prisma.uploadedAsset.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        category: true,
        access: true,
        status: true,
        sizeBytes: true,
        createdAt: true,
      },
    }),
    prisma.privacyRequest.findMany({
      where: { userId },
      orderBy: { requestedAt: "asc" },
      select: {
        id: true,
        type: true,
        status: true,
        reasonCode: true,
        requestedAt: true,
        completedAt: true,
      },
    }),
  ]);

  const payload: UserExportPayload = {
    exportedAt: new Date().toISOString(),
    format: "campus-marketplace.user-export/v1",
    account: {
      id: user.id,
      name: user.name,
      email: user.email,
      schoolName: user.schoolName,
      campusId: user.campusId,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      college: user.college,
      grade: user.grade,
      verificationStatus: user.verificationStatus,
      createdAt: user.createdAt.toISOString(),
    },
    policyAcceptances: acceptances.map((acceptance) => ({
      documentType: acceptance.documentType,
      documentVersion: acceptance.documentVersion,
      documentHash: acceptance.documentHash,
      source: acceptance.source,
      acceptedAt: acceptance.acceptedAt.toISOString(),
    })),
    listings: {
      products: products.map((product) => ({
        ...product,
        price: String(product.price),
        createdAt: product.createdAt.toISOString(),
      })),
      errandTasks: errandTasks.map((task) => ({
        ...task,
        reward: String(task.reward),
        createdAt: task.createdAt.toISOString(),
      })),
      serviceListings: serviceListings.map((listing) => ({
        ...listing,
        price: String(listing.price),
        createdAt: listing.createdAt.toISOString(),
      })),
      rentalListings: rentalListings.map((listing) => ({
        ...listing,
        price: String(listing.price),
        createdAt: listing.createdAt.toISOString(),
      })),
    },
    orders: [
      ...ordersAsBuyer.map((order) => ({
        id: order.id,
        orderNo: order.orderNo,
        type: order.type,
        status: order.status,
        amount: String(order.amount),
        role: "buyer" as const,
        counterparty: pickCounterparty(order.seller),
        createdAt: order.createdAt.toISOString(),
      })),
      ...ordersAsSeller.map((order) => ({
        id: order.id,
        orderNo: order.orderNo,
        type: order.type,
        status: order.status,
        amount: String(order.amount),
        role: "seller" as const,
        counterparty: pickCounterparty(order.buyer),
        createdAt: order.createdAt.toISOString(),
      })),
    ],
    rentalOrders: [
      ...rentalOrdersAsOwner.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        role: "owner" as const,
        counterparty: pickCounterparty(order.renter),
        startTime: order.startTime.toISOString(),
        endTime: order.endTime.toISOString(),
      })),
      ...rentalOrdersAsRenter.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        role: "renter" as const,
        counterparty: pickCounterparty(order.owner),
        startTime: order.startTime.toISOString(),
        endTime: order.endTime.toISOString(),
      })),
    ],
    reviewsWritten: reviewsWritten.map((review) => ({
      id: review.id,
      orderId: review.orderId,
      rating: review.rating,
      content: review.content,
      target: pickCounterparty(review.targetUser),
      createdAt: review.createdAt.toISOString(),
    })),
    reportsFiled: reportsFiled.map((report) => ({
      id: report.id,
      targetType: report.targetType,
      reason: report.reason,
      status: report.status,
      targetUser: pickCounterparty(report.targetUser),
      createdAt: report.createdAt.toISOString(),
    })),
    messagesSent: messagesSent.map((message) => ({
      id: message.id,
      conversationId: message.conversationId,
      type: message.type,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
    })),
    uploadedAssets: uploadedAssets.map((asset) => ({
      id: asset.id,
      category: asset.category,
      access: asset.access,
      status: asset.status,
      sizeBytes: asset.sizeBytes,
      createdAt: asset.createdAt.toISOString(),
    })),
    privacyRequests: privacyRequests.map((request) => ({
      id: request.id,
      type: request.type,
      status: request.status,
      reasonCode: request.reasonCode,
      requestedAt: request.requestedAt.toISOString(),
      completedAt: request.completedAt?.toISOString() ?? null,
    })),
  };

  assertNoForbiddenExportFields(payload);

  const serialized = JSON.stringify(payload);

  if (Buffer.byteLength(serialized, "utf8") > EXPORT_MAX_BYTES) {
    throw governanceError("DATA_EXPORT_TOO_LARGE");
  }

  return payload;
}

/**
 * 泄漏防护扫描（也被测试复用）：递归检查载荷中不出现任何禁止键名。
 * 放在这里而不是只放测试里，是为了让运行时出口同样受保护。
 */
export function assertNoForbiddenExportFields(payload: unknown): void {
  const forbidden = new Set<string>(FORBIDDEN_EXPORT_KEYS);

  const visit = (node: unknown, keyPath: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${keyPath}[${index}]`));
      return;
    }

    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (forbidden.has(key)) {
          throw new Error(`导出载荷出现禁止字段: ${keyPath}.${key}`);
        }

        visit(value, keyPath ? `${keyPath}.${key}` : key);
      }
    }
  };

  visit(payload, "");
}

export type SynchronousExportResult = {
  payload: UserExportPayload;
  request: {
    id: string;
    status: "COMPLETED";
    completedAt: string;
  };
};

export type ExportExecutionErrorCode = "DATA_EXPORT_TOO_LARGE" | "EXPORT_EXECUTION_FAILED";

export type ExportExecutionResult =
  | SynchronousExportResult
  | {
      ok: false;
      request: {
        id: string;
        status: "REJECTED";
        reasonCode: ExportExecutionErrorCode;
      };
      errorCode: ExportExecutionErrorCode;
      /** 原始构建错误（非 too-large 失败向调用方原样上抛，保留日志/分类语义） */
      originalError: unknown;
    };

/**
 * 同步数据导出的唯一执行入口（Phase 5 REPAIR 2：失败台账必须持久化）。
 *
 * 一次真实导出形成且仅形成一条 PrivacyRequest：
 *   成功：REQUESTED → IN_PROGRESS → build → validate → COMPLETED → COMMIT → 响应载荷
 *   失败：REQUESTED → IN_PROGRESS → REJECTED(reasonCode) → COMMIT → 事务外抛错
 *
 * REPAIR 2 关键语义：失败路径在事务 callback 内 **return**（而不是 throw），
 * 因此 REJECTED 台账随事务 COMMIT 持久化；错误在事务提交之后才向调用方抛出。
 * （此前"catch 内 REJECTED 再 throw"会被 interactive transaction 的整体
 * rollback 吞掉，台账从未落库。）
 *
 * snapshot 语义（准确表述）：request lifecycle 在单一事务内提交；
 * DTO 构建使用普通 DB 读（独立快照），不声称与 lifecycle 同一快照。
 *
 * @param builder 构建函数注入点：仅测试 seam 使用（真实 PG 失败持久化测试），
 *                生产路径使用默认 buildUserExport。
 */
export async function executeSynchronousDataExport(
  userId: string,
  builder: (userId: string) => Promise<UserExportPayload> = buildUserExport,
): Promise<SynchronousExportResult> {
  const result = await withTransaction(async (tx) => {
    const created = await tx.privacyRequest.create({
      data: { userId, type: "DATA_EXPORT", status: "REQUESTED" },
    });

    logger.info("privacy_request_created", "privacy", {
      requestId: created.id,
      requestType: created.type,
    });

    const inProgress = await transitionPrivacyRequest(created.id, "IN_PROGRESS", undefined, tx);

    try {
      const payload = await builder(userId);

      const completed = await transitionPrivacyRequest(inProgress.id, "COMPLETED", undefined, tx);

      logger.info("privacy_request_completed", "privacy", {
        requestId: completed.id,
        requestType: completed.type,
      });

      return {
        ok: true as const,
        payload,
        request: {
          id: completed.id,
          status: "COMPLETED" as const,
          completedAt: (completed.completedAt ?? new Date()).toISOString(),
        },
      };
    } catch (error) {
      // 失败不得留下虚假 COMPLETED，也不得让 REJECTED 被 rollback 吞掉：
      // 在 callback 内 return 失败结果，让事务以 REJECTED 提交。
      const tooLarge = isGovernanceError(error) && error.code === "DATA_EXPORT_TOO_LARGE";
      const errorCode: ExportExecutionErrorCode = tooLarge
        ? "DATA_EXPORT_TOO_LARGE"
        : "EXPORT_EXECUTION_FAILED";

      const rejected = await transitionPrivacyRequest(inProgress.id, "REJECTED", { reasonCode: errorCode }, tx);

      if (!tooLarge) {
        // 非预期失败保留原始错误证据（日志），事务外再原样上抛
        logger.error("privacy_export_execution_failed", "privacy", {
          requestId: rejected.id,
          userId,
          error,
        });
      }

      return {
        ok: false as const,
        request: {
          id: rejected.id,
          status: "REJECTED" as const,
          reasonCode: errorCode,
        },
        errorCode,
        originalError: error,
      };
    }
  });

  if (!result.ok) {
    // 事务已 COMMIT（REJECTED 已持久化），现在才向调用方抛安全错误
    if (result.errorCode === "DATA_EXPORT_TOO_LARGE") {
      throw governanceError("DATA_EXPORT_TOO_LARGE");
    }

    throw result.originalError;
  }

  logger.info("privacy_export_served", "privacy", { userId });

  return result;
}
