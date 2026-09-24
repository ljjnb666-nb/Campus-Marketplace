import { randomUUID } from "node:crypto";
import {
  PrismaClient,
  type AssetAccess,
  type AssetCategory,
  type AssetStatus,
  type RentalOrderStatus,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Repair 4 / RB-04 Privacy Lifecycle Erasure 集成测试（真实 PostgreSQL）。
 *
 * 在生产路径（eraseAccount / updateOwnProfileTx / submitMembershipVerification /
 * decideMembershipVerification / rejectRentalOrderTx，真实 withTransaction +
 * USER 治理锁）上证明 erasure completeness（REGISTRY 分类逐字段执行）、
 * 替换清理同事务原子性（ASSET-03/04）与 secondary-copy 规则
 * （SECONDARY-01/02/03）。物理对象删除（MinIO）在 repair4-privacy-assets
 * 集成测试中证明。
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 90_000 });

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const prisma = integrationDatabaseUrl ? (await import("@/lib/prisma")).prisma : null;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `rb04it-${randomUUID().slice(0, 8)}`;
const RB04_CAMPUS_SLUG = "rb04-privacy-it";

const ERASED_MARKER = "（该内容已随账号注销删除）";

const { integrationRequireUser } = vi.hoisted(() => ({
  integrationRequireUser: vi.fn(),
}));

vi.mock("@/lib/server-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server-auth")>();
  return { ...actual, requireUser: integrationRequireUser };
});

describe.skipIf(!integrationDatabaseUrl)("Repair 4 privacy erasure lifecycle (RB-04, real PostgreSQL)", () => {
  let campusId = "";
  const userIds: string[] = [];
  const adHocRoleIds: string[] = [];
  const assignmentIds: string[] = [];
  const orderIds: string[] = [];
  const rentalOrderIds: string[] = [];
  const rentalListingIds: string[] = [];
  const productIds: string[] = [];
  const errandTaskIds: string[] = [];
  const serviceListingIds: string[] = [];
  const productCategorySlug = `${RUN_TAG}-pc`;
  const rentalCategorySlug = `${RUN_TAG}-rc`;
  const errandCategorySlug = `${RUN_TAG}-ec`;
  const serviceCategorySlug = `${RUN_TAG}-sc`;
  const productCategoryRef: { id: string } = { id: "" };
  const rentalCategoryRef: { id: string } = { id: "" };
  const errandCategoryRef: { id: string } = { id: "" };
  const serviceCategoryRef: { id: string } = { id: "" };
  const assetIds: string[] = [];
  const verificationIds: string[] = [];
  const enforcementIds: string[] = [];
  const conversationIds: string[] = [];

  async function createFixtureUser(name: string, status: "ACTIVE" | "SUSPENDED" = "ACTIVE") {
    const user = await rawClient!.user.create({
      data: {
        email: `${RUN_TAG}-${userIds.length}-${name}@it.local`,
        name,
        passwordHash: "$2a$10$itfixtureitfixtureitfixtureitfixtureitfixtureitfix",
        schoolName: "集成测试大学",
        campusId,
        role: "STUDENT",
        status,
      },
    });
    userIds.push(user.id);
    return user;
  }

  async function createActiveMembership(userId: string) {
    return rawClient!.campusMembership.create({
      data: { userId, campusId, status: "ACTIVE" },
    });
  }

  async function createRentalListing(ownerId: string) {
    const listing = await rawClient!.rentalListing.create({
      data: {
        title: `${RUN_TAG} 出租物品`,
        description: "集成测试租赁物品",
        condition: "LIKE_NEW",
        price: "10.00",
        pricingUnit: "PER_DAY",
        depositAmount: "0",
        minimumDuration: 1,
        maximumDuration: 30,
        totalQuantity: 1,
        availableQuantity: 1,
        ownerId,
        campusId,
        categoryId: rentalCategoryRef.id,
        status: "AVAILABLE",
        pickupLocation: "北门",
        returnLocation: "北门",
      },
    });
    rentalListingIds.push(listing.id);
    return listing;
  }

  async function createRentalOrder(input: {
    ownerId: string;
    renterId: string;
    listingId: string;
    renterNote?: string | null;
    cancellationNote?: string | null;
    cancelledById?: string | null;
    status?: RentalOrderStatus;
  }) {
    const order = await rawClient!.rentalOrder.create({
      data: {
        orderNumber: `RO${RUN_TAG}${rentalOrderIds.length}`,
        rentalListingId: input.listingId,
        ownerId: input.ownerId,
        renterId: input.renterId,
        startTime: new Date("2026-09-01T00:00:00Z"),
        endTime: new Date("2026-09-02T00:00:00Z"),
        quantity: 1,
        unitPriceSnapshot: "10.00",
        pricingUnitSnapshot: "PER_DAY",
        rentalDuration: 1,
        rentalAmount: "10.00",
        depositAmount: "0",
        finalAmount: "10.00",
        paymentStatus: "OFFLINE_PENDING",
        depositStatus: "NOT_REQUIRED",
        status: input.status ?? "COMPLETED",
        pickupLocationSnapshot: "北门",
        returnLocationSnapshot: "北门",
        renterNote: input.renterNote ?? null,
        cancellationNote: input.cancellationNote ?? null,
        cancelledById: input.cancelledById ?? null,
        completedAt: input.status === "COMPLETED" ? new Date() : null,
      },
    });
    rentalOrderIds.push(order.id);
    return order;
  }

  async function createAsset(input: {
    ownerId: string;
    category: AssetCategory;
    access: AssetAccess;
    status: AssetStatus;
    originalFileName?: string | null;
    verificationId?: string;
  }) {
    const asset = await rawClient!.uploadedAsset.create({
      data: {
        ownerId: input.ownerId,
        category: input.category,
        access: input.access,
        bucket: input.access === "PUBLIC" ? "campus-public" : "campus-private",
        objectKey: `${RUN_TAG}/${input.category.toLowerCase()}/${assetIds.length}`,
        mimeType: "image/webp",
        sizeBytes: 100,
        width: 64,
        height: 64,
        originalFileName: input.originalFileName ?? null,
        status: input.status,
        attachedAt: input.status === "ATTACHED" ? new Date() : null,
        verificationId: input.verificationId,
      },
    });
    assetIds.push(asset.id);
    return asset;
  }

  beforeAll(async () => {
    const campus = await rawClient!.campus.upsert({
      where: { slug: RB04_CAMPUS_SLUG },
      create: { name: "RB04 集成校区", slug: RB04_CAMPUS_SLUG, schoolName: "集成测试大学" },
      update: {},
    });
    campusId = campus.id;

    const productCategory = await rawClient!.productCategory.upsert({
      where: { slug: productCategorySlug },
      create: { name: productCategorySlug, slug: productCategorySlug },
      update: {},
    });
    productCategoryRef.id = productCategory.id;

    const rentalCategory = await rawClient!.rentalCategory.upsert({
      where: { slug: rentalCategorySlug },
      create: { name: rentalCategorySlug, slug: rentalCategorySlug },
      update: {},
    });
    rentalCategoryRef.id = rentalCategory.id;

    const errandCategory = await rawClient!.errandCategory.upsert({
      where: { slug: errandCategorySlug },
      create: { name: errandCategorySlug, slug: errandCategorySlug },
      update: {},
    });
    errandCategoryRef.id = errandCategory.id;

    const serviceCategory = await rawClient!.serviceCategory.upsert({
      where: { slug: serviceCategorySlug },
      create: { name: serviceCategorySlug, slug: serviceCategorySlug },
      update: {},
    });
    serviceCategoryRef.id = serviceCategory.id;
  });

  afterAll(async () => {
    await rawClient!.userRoleAssignment.deleteMany({ where: { id: { in: assignmentIds } } });
    await rawClient!.rolePermission.deleteMany({ where: { roleId: { in: adHocRoleIds } } });
    await rawClient!.role.deleteMany({ where: { id: { in: adHocRoleIds } } });
    await rawClient!.rentalDispute.deleteMany({ where: { orderId: { in: rentalOrderIds } } });
    await rawClient!.rentalOrderStatusLog.deleteMany({ where: { orderId: { in: rentalOrderIds } } });
    await rawClient!.rentalReview.deleteMany({ where: { orderId: { in: rentalOrderIds } } });
    await rawClient!.rentalOrder.deleteMany({
      where: { OR: [{ ownerId: { in: userIds } }, { renterId: { in: userIds } }] },
    });
    await rawClient!.dataHold.deleteMany({ where: { subjectId: { in: userIds } } });
    await rawClient!.uploadedAsset.deleteMany({ where: { id: { in: assetIds } } });
    await rawClient!.userVerification.deleteMany({ where: { id: { in: verificationIds } } });
    await rawClient!.appeal.deleteMany({ where: { enforcementActionId: { in: enforcementIds } } });
    await rawClient!.enforcementAction.deleteMany({ where: { id: { in: enforcementIds } } });
    await rawClient!.supportTicket.deleteMany({ where: { requesterId: { in: userIds } } });
    await rawClient!.blockedUser.deleteMany({ where: { blockerId: { in: userIds } } });
    await rawClient!.errandTask.deleteMany({ where: { id: { in: errandTaskIds } } });
    await rawClient!.serviceListing.deleteMany({ where: { id: { in: serviceListingIds } } });
    await rawClient!.notification.deleteMany({ where: { userId: { in: userIds } } });
    await rawClient!.review.deleteMany({
      where: { OR: [{ authorId: { in: userIds } }, { targetUserId: { in: userIds } }] },
    });
    await rawClient!.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await rawClient!.conversationParticipant.deleteMany({ where: { conversationId: { in: conversationIds } } });
    await rawClient!.conversation.deleteMany({ where: { id: { in: conversationIds } } });
    await rawClient!.report.deleteMany({ where: { reporterId: { in: userIds } } });
    await rawClient!.order.deleteMany({ where: { OR: [{ buyerId: { in: userIds } }, { sellerId: { in: userIds } }] } });
    await rawClient!.privacyRequest.deleteMany({ where: { userId: { in: userIds } } });
    await rawClient!.product.deleteMany({ where: { id: { in: productIds } } });
    await rawClient!.rentalListing.deleteMany({ where: { id: { in: rentalListingIds } } });
    await rawClient!.productCategory.deleteMany({ where: { id: productCategoryRef.id } });
    await rawClient!.rentalCategory.deleteMany({ where: { id: rentalCategoryRef.id } });
    await rawClient!.errandCategory.deleteMany({ where: { id: errandCategoryRef.id } });
    await rawClient!.serviceCategory.deleteMany({ where: { id: serviceCategoryRef.id } });
    await rawClient!.campusMembership.deleteMany({ where: { userId: { in: userIds } } });
    await rawClient!.user.deleteMany({ where: { id: { in: userIds } } });
    // 不删除 Campus 行（稳定 slug 复用）
    await rawClient!.$disconnect();
    await prisma?.$disconnect();
  });

  it("ERASE-01..12 + ASSET-01/02：eraseAccount 逐字段执行 registry 分类（真 PG）", async () => {
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");
    const { resolveImageTokens } = await import("@/lib/upload");

    const target = await createFixtureUser("RB04 注销目标");
    const other = await createFixtureUser("RB04 对照用户");
    const targetMembership = await createActiveMembership(target.id);
    await createActiveMembership(other.id);

    // ---- UserVerification（含 reviewNote + 认证资产绑定） ----
    const verification = await rawClient!.userVerification.create({
      data: {
        userId: target.id,
        membershipId: targetMembership.id,
        schoolName: "示例大学",
        campusName: "主校区",
        studentIdLast4: "1234",
        studentCardImage: "legacy-direct-url",
        status: "REJECTED",
        reviewNote: "内部审核备注X",
        reasonCode: "VERIFICATION_MATERIALS_INVALID",
        submittedAt: new Date(),
        reviewDueAt: new Date(Date.now() + 48 * 3600_000),
      },
    });
    verificationIds.push(verification.id);
    await createAsset({
      ownerId: target.id,
      category: "VERIFICATION",
      access: "PRIVATE",
      status: "ATTACHED",
      originalFileName: "student-card.png",
      verificationId: verification.id,
    });

    // ---- Notifications（本人 inbox，注销即删） ----
    await rawClient!.notification.create({
      data: { userId: target.id, type: "SYSTEM", title: "标题A", content: "通知内容X" },
    });

    // ---- Messages：本人发送 + 他人发送（对照） ----
    const conversation = await rawClient!.conversation.create({
      data: {
        participants: {
          create: [{ userId: target.id }, { userId: other.id }],
        },
      },
    });
    conversationIds.push(conversation.id);
    await rawClient!.message.create({
      data: { conversationId: conversation.id, senderId: target.id, type: "DIRECT", content: "本人消息原文X" },
    });
    await rawClient!.message.create({
      data: { conversationId: conversation.id, senderId: other.id, type: "DIRECT", content: "对照消息原文" },
    });

    // ---- Review / RentalReview ----
    const product = await rawClient!.product.create({
      data: {
        title: `${RUN_TAG} 商品`,
        description: "集成测试商品",
        price: "5.00",
        locationText: "北门",
        condition: "LIKE_NEW",
        sellerId: other.id,
        campusId,
        categoryId: productCategoryRef.id,
      },
    });
    productIds.push(product.id);
    const generalOrder = await rawClient!.order.create({
      data: {
        orderNo: `GO${RUN_TAG}A`,
        type: "PRODUCT",
        status: "COMPLETED",
        paymentStatus: "OFFLINE_PENDING",
        amount: "5.00",
        note: "买家留言X",
        cancelReason: "中途取消原因X",
        buyerId: target.id,
        sellerId: other.id,
        productId: product.id,
      },
    });
    orderIds.push(generalOrder.id);

    await rawClient!.review.create({
      data: { orderId: generalOrder.id, authorId: target.id, targetUserId: other.id, rating: 5, content: "本人评价原文X", tags: [" tagA"] },
    });
    await rawClient!.review.create({
      data: { orderId: generalOrder.id, authorId: other.id, targetUserId: target.id, rating: 4, content: "对照评价原文", tags: ["tagB"] },
    });

    const rentalListing = await createRentalListing(other.id);
    const targetRental = await createRentalOrder({
      ownerId: other.id,
      renterId: target.id,
      listingId: rentalListing.id,
      renterNote: "租客备注X",
    });
    await rawClient!.rentalReview.create({
      data: { orderId: targetRental.id, authorId: target.id, targetUserId: other.id, overallRating: 5, content: "本人租赁评价X", tags: ["tagC"] },
    });

    // 本人作为 operator 的 status log + 对照 log
    await rawClient!.rentalOrderStatusLog.create({
      data: { orderId: targetRental.id, fromStatus: "PENDING_APPROVAL", toStatus: "PENDING_PICKUP", operatorId: target.id, note: "本人日志备注X" },
    });
    await rawClient!.rentalOrderStatusLog.create({
      data: { orderId: targetRental.id, fromStatus: "PENDING_PICKUP", toStatus: "IN_RENTAL", operatorId: other.id, note: "对照日志备注" },
    });

    // 本人取消的租赁单（cancelledBy 归属精确）
    await createRentalOrder({
      ownerId: other.id,
      renterId: other.id,
      listingId: rentalListing.id,
      cancellationNote: "本人取消原因X",
      cancelledById: target.id,
      status: "CANCELLED",
    });

    // ---- Report（本人 detail + operator handledNote） ----
    await rawClient!.report.create({
      data: {
        targetType: "USER",
        reason: "ADVERTISEMENT",
        detail: "本人举报详情X",
        status: "RESOLVED",
        reporterId: target.id,
        targetUserId: other.id,
        handledById: other.id,
        handledNote: "operator 处理备注X",
        scopeKey: "UNSCOPED",
      },
    });

    // ---- Appeal（本人 statement + operator decisionNote） ----
    const enforcement = await rawClient!.enforcementAction.create({
      data: {
        type: "ACCOUNT_SUSPEND",
        actorId: other.id,
        targetId: target.id,
        scopeKey: "GLOBAL",
        reasonCode: "POLICY_VIOLATION",
        resultState: "USER:SUSPENDED",
        note: "enforcement 内部备注",
      },
    });
    enforcementIds.push(enforcement.id);
    await rawClient!.appeal.create({
      data: {
        enforcementActionId: enforcement.id,
        status: "DISMISSED",
        statement: "本人申诉原文X",
        reviewDueAt: new Date(Date.now() + 48 * 3600_000),
        decisionReasonCode: "MERIT_VIOLATION_CONFIRMED",
        decisionNote: "内部决定备注X",
      },
    });

    // ---- RentalDispute（terminal，本人发起） ----
    await rawClient!.rentalDispute.create({
      data: {
        orderId: targetRental.id,
        initiatorId: target.id,
        reason: "本人纠纷原因X",
        evidencePhotos: ["asset:nonexistent"],
        status: "RESOLVED",
        campusId,
        scopeKey: `CAMPUS:${campusId}`,
        dueAt: new Date(Date.now() + 48 * 3600_000),
        resolutionCode: "MUTUAL_AGREEMENT",
        resolutionAction: "RESTORE_PREVIOUS",
      },
    });

    // ---- UploadedAsset 全状态矩阵 ----
    const attachedAvatar = await createAsset({
      ownerId: target.id,
      category: "AVATAR",
      access: "PUBLIC",
      status: "ATTACHED",
      originalFileName: "avatar.png",
    });
    const uploadedVerification = await createAsset({
      ownerId: target.id,
      category: "VERIFICATION",
      access: "PRIVATE",
      status: "UPLOADED",
      originalFileName: "card2.png",
    });
    const attachedReport = await createAsset({
      ownerId: target.id,
      category: "REPORT",
      access: "PRIVATE",
      status: "ATTACHED",
      originalFileName: "damage.png",
    });
    const productAsset = await createAsset({
      ownerId: target.id,
      category: "PRODUCT",
      access: "PUBLIC",
      status: "ATTACHED",
      originalFileName: "product.png",
    });
    const uploadingAsset = await createAsset({
      ownerId: target.id,
      category: "AVATAR",
      access: "PUBLIC",
      status: "UPLOADING",
      originalFileName: "in-flight.png",
    });
    const pendingDeleteAsset = await createAsset({
      ownerId: target.id,
      category: "HANDOVER",
      access: "PRIVATE",
      status: "PENDING_DELETE",
      originalFileName: "handover.png",
    });
    const deletedAsset = await createAsset({
      ownerId: target.id,
      category: "RETURN",
      access: "PRIVATE",
      status: "DELETED",
      originalFileName: "return.png",
    });

    await rawClient!.user.update({
      where: { id: target.id },
      data: { avatarUrl: `asset:${attachedAvatar.id}` },
    });

    // ---- 生产路径注销 ----
    const result = await eraseAccount(target.id);
    expect(result.userId).toBe(target.id);

    // ERASE-01：profile direct identity
    const erasedUser = await rawClient!.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(erasedUser.erasedAt).toBeTruthy();
    expect(erasedUser.name).toBe("已注销用户");
    expect(erasedUser.email).toMatch(/^erased-.*@erased\.invalid$/);
    expect(erasedUser.avatarUrl).toBeNull();
    expect(erasedUser.phone).toBeNull();
    expect(erasedUser.bio).toBeNull();
    expect(erasedUser.studentIdLast4).toBeNull();
    expect(erasedUser.verificationStatus).toBe("UNVERIFIED");

    // ERASE-02：verification reviewNote 清空 + 状态回 UNVERIFIED
    const erasedVerification = await rawClient!.userVerification.findUniqueOrThrow({
      where: { userId: target.id },
    });
    expect(erasedVerification.reviewNote).toBeNull();
    expect(erasedVerification.status).toBe("UNVERIFIED");
    expect(erasedVerification.studentCardImage).toBe("erased");
    expect(erasedVerification.studentIdLast4).toBe("0000");

    // ERASE-03：notifications 整表删除
    expect(await rawClient!.notification.count({ where: { userId: target.id } })).toBe(0);

    // ERASE-04：message content → marker + senderId null；他人消息不动
    const messages = await rawClient!.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "asc" },
    });
    expect(messages[0]!.content).toBe(ERASED_MARKER);
    expect(messages[0]!.senderId).toBeNull();
    expect(messages[1]!.content).toBe("对照消息原文");
    expect(messages[1]!.senderId).toBe(other.id);

    // ERASE-05：本人 authored 评价清文本；他人评价保留
    const reviews = await rawClient!.review.findMany({ where: { orderId: generalOrder.id } });
    const targetReview = reviews.find((review) => review.authorId === target.id)!;
    const otherReview = reviews.find((review) => review.authorId === other.id)!;
    expect(targetReview.content).toBeNull();
    expect(targetReview.tags).toEqual([]);
    expect(targetReview.rating).toBe(5);
    expect(otherReview.content).toBe("对照评价原文");
    const rentalReview = await rawClient!.rentalReview.findFirstOrThrow({
      where: { orderId: targetRental.id, authorId: target.id },
    });
    expect(rentalReview.content).toBeNull();
    expect(rentalReview.tags).toEqual([]);
    expect(rentalReview.overallRating).toBe(5);

    // ERASE-06：report detail 清空；handledNote（governance）保留
    const report = await rawClient!.report.findFirstOrThrow({ where: { reporterId: target.id } });
    expect(report.detail).toBeNull();
    expect(report.handledNote).toBe("operator 处理备注X");
    expect(report.reason).toBe("ADVERTISEMENT");

    // ERASE-07：appeal statement → marker；decisionNote（operator）保留
    const appeal = await rawClient!.appeal.findUniqueOrThrow({
      where: { enforcementActionId: enforcement.id },
    });
    expect(appeal.statement).toBe(ERASED_MARKER);
    expect(appeal.decisionNote).toBe("内部决定备注X");

    // ERASE-08：order 参与者歧义 free text 清空；结构保留
    const erasedGeneralOrder = await rawClient!.order.findUniqueOrThrow({ where: { id: generalOrder.id } });
    expect(erasedGeneralOrder.note).toBeNull();
    expect(erasedGeneralOrder.cancelReason).toBeNull();
    expect(erasedGeneralOrder.amount.toFixed(2)).toBe("5.00");
    expect(erasedGeneralOrder.status).toBe("COMPLETED");

    // ERASE-09：rental free text 按精确归属清理
    const erasedTargetRental = await rawClient!.rentalOrder.findUniqueOrThrow({ where: { id: targetRental.id } });
    expect(erasedTargetRental.renterNote).toBeNull();
    const erasedCancelled = await rawClient!.rentalOrder.findFirstOrThrow({
      where: { cancelledById: target.id },
    });
    expect(erasedCancelled.cancellationNote).toBeNull();

    // ERASE-10：本人 operator 的 status log note 清空；对照保留
    const logs = await rawClient!.rentalOrderStatusLog.findMany({
      where: { orderId: targetRental.id },
      orderBy: { createdAt: "asc" },
    });
    expect(logs[0]!.operatorId).toBe(target.id);
    expect(logs[0]!.note).toBeNull();
    expect(logs[1]!.operatorId).toBe(other.id);
    expect(logs[1]!.note).toBe("对照日志备注");

    // ERASE-11 / 32：support ticket 文本在独立 fixture 中由 ACTIVE 阻断与
    // terminal 清理覆盖（本文件 RB04 专注 registry 主矩阵）。
    void ERASED_MARKER;

    // ERASE-31：terminal dispute reason/evidence 清理
    const dispute = await rawClient!.rentalDispute.findFirstOrThrow({
      where: { orderId: targetRental.id, initiatorId: target.id },
    });
    expect(dispute.reason).toBe(ERASED_MARKER);
    expect(dispute.evidencePhotos).toEqual([]);

    // ERASE-12 / 43：全部 owner 资产 originalFileName 清空（任意状态）
    for (const assetId of [attachedAvatar.id, uploadedVerification.id, attachedReport.id, productAsset.id, uploadingAsset.id, pendingDeleteAsset.id, deletedAsset.id]) {
      const asset = await rawClient!.uploadedAsset.findUniqueOrThrow({ where: { id: assetId } });
      expect(asset.originalFileName, `asset ${asset.category}/${asset.status} 文件名必须清空`).toBeNull();
    }

    // ASSET-01/02：敏感类别 UPLOADED/ATTACHED → PENDING_DELETE
    expect((await rawClient!.uploadedAsset.findUniqueOrThrow({ where: { id: attachedAvatar.id } })).status).toBe("PENDING_DELETE");
    expect((await rawClient!.uploadedAsset.findUniqueOrThrow({ where: { id: uploadedVerification.id } })).status).toBe("PENDING_DELETE");
    expect((await rawClient!.uploadedAsset.findUniqueOrThrow({ where: { id: attachedReport.id } })).status).toBe("PENDING_DELETE");
    // UPLOADING 保持既有 TTL 恢复合同（不直接切 PENDING_DELETE）
    expect((await rawClient!.uploadedAsset.findUniqueOrThrow({ where: { id: uploadingAsset.id } })).status).toBe("UPLOADING");
    // REVIEW FIX §10/§18：listing 镜像资产（PRODUCT，含 PUBLIC）同样进入
    // durable deletion queue；listing 行本身保留（结构历史）
    expect((await rawClient!.uploadedAsset.findUniqueOrThrow({ where: { id: productAsset.id } })).status).toBe("PENDING_DELETE");

    // spec 41：erasure 后 stale 资产无法再 attach（fail closed）
    await expect(
      resolveImageTokens({
        ownerId: target.id,
        tokens: [`asset:${uploadedVerification.id}`],
        target: { type: "verification", id: verification.id },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ASSET_REFERENCE" });
  });

  it("REVIEW FIX R4-03/§21：listing/order 附属 user-authored canary 全清（真 PG）", async () => {
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");

    const owner = await createFixtureUser("R4R3 注销店主");
    const counterpart = await createFixtureUser("R4R3 对照对象");
    await createActiveMembership(owner.id);
    await createActiveMembership(counterpart.id);

    // §21 canary：schoolName（R4-01）
    await rawClient!.user.update({
      where: { id: owner.id },
      data: { schoolName: "隐私学校-DO-NOT-SURVIVE" },
    });

    // ---- listing 面（owner 唯一作者）----
    const rentalListing = await createRentalListing(owner.id);
    await rawClient!.rentalListing.update({
      where: { id: rentalListing.id },
      data: {
        title: "私人租赁标题",
        description: "private-rental-description",
        brand: "private-brand",
        model: "private-model",
        pickupLocation: "私人取货地点",
        returnLocation: "私人归还地点",
        usageRules: "private-rules",
        damagePolicy: "private-damage-policy",
        overduePolicy: "private-overdue-policy",
      },
    });
    await rawClient!.rentalListingImage.create({
      data: { rentalListingId: rentalListing.id, url: "canary-rental-image", sortOrder: 0 },
    });
    const rentalImageAsset = await createAsset({
      ownerId: owner.id,
      category: "RENTAL",
      access: "PUBLIC",
      status: "ATTACHED",
      originalFileName: "rental.png",
    });
    await rawClient!.uploadedAsset.update({
      where: { id: rentalImageAsset.id },
      data: { rentalListingId: rentalListing.id },
    });

    const product = await rawClient!.product.create({
      data: {
        title: "私人商品标题-DO-NOT-SURVIVE",
        description: "private-product-description",
        price: "3.00",
        locationText: "宿舍A栋301-DO-NOT-SURVIVE",
        condition: "LIKE_NEW",
        sellerId: owner.id,
        campusId,
        categoryId: productCategoryRef.id,
      },
    });
    productIds.push(product.id);
    await rawClient!.productImage.create({
      data: { productId: product.id, url: "canary-product-image", sortOrder: 0 },
    });
    const productAsset = await createAsset({
      ownerId: owner.id,
      category: "PRODUCT",
      access: "PUBLIC",
      status: "ATTACHED",
      originalFileName: "product.png",
    });
    await rawClient!.uploadedAsset.update({
      where: { id: productAsset.id },
      data: { productId: product.id },
    });

    const serviceListing = await rawClient!.serviceListing.create({
      data: {
        title: "私人服务标题",
        description: "private-service-description",
        locationText: "私人服务地点",
        availableSchedule: "每晚22点后微信联系",
        coverImageUrl: "canary-service-cover",
        categoryId: serviceCategoryRef.id,
        price: "8.00",
        pricingUnit: "PER_SESSION",
        providerId: owner.id,
        campusId,
      },
    });
    serviceListingIds.push(serviceListing.id);
    const serviceAsset = await createAsset({
      ownerId: owner.id,
      category: "SERVICE",
      access: "PUBLIC",
      status: "ATTACHED",
      originalFileName: "service.png",
    });
    await rawClient!.uploadedAsset.update({
      where: { id: serviceAsset.id },
      data: { serviceListingId: serviceListing.id },
    });

    const errandTask = await rawClient!.errandTask.create({
      data: {
        title: "私人跑腿标题-DO-NOT-SURVIVE",
        description: "private-errand-description",
        categoryId: errandCategoryRef.id,
        reward: "2.00",
        pickupLocation: "宿舍B栋201",
        deliveryLocation: "私人送达地点",
        contactNote: "微信 private-contact",
        deadline: new Date(Date.now() + 24 * 3600_000),
        publisherId: owner.id,
        campusId,
      },
    });
    errandTaskIds.push(errandTask.id);

    // BlockedUser：owner blocks counterpart（reason canary）
    await rawClient!.blockedUser.create({
      data: { blockerId: owner.id, blockedUserId: counterpart.id, reason: "private-block-reason" },
    });

    // ---- rental terminal 附属文本（owner=owner 的订单）----
    const orderOwnerIsTarget = await createRentalOrder({
      ownerId: owner.id,
      renterId: counterpart.id,
      listingId: rentalListing.id,
      status: "COMPLETED",
    });
    await rawClient!.rentalDamageClaim.create({
      data: {
        orderId: orderOwnerIsTarget.id,
        submittedById: owner.id,
        damageDescription: "private-damage-description",
        requestedDeduction: "0",
        photos: ["canary-damage-photo-token"],
      },
    });
    await rawClient!.rentalExtensionRequest.create({
      data: {
        orderId: orderOwnerIsTarget.id,
        requesterId: counterpart.id,
        newEndTime: new Date(Date.now() + 72 * 3600_000),
        additionalFee: "1.00",
        ownerNote: "private-owner-note",
      },
    });
    await rawClient!.rentalReturnRecord.create({
      data: {
        orderId: orderOwnerIsTarget.id,
        photos: [],
        inspectionNote: "private-inspection-note",
      },
    });
    await rawClient!.rentalUnavailablePeriod.create({
      data: {
        rentalListingId: rentalListing.id,
        startDate: new Date(Date.now() + 24 * 3600_000),
        endDate: new Date(Date.now() + 48 * 3600_000),
        reason: "private-unavailable-reason",
      },
    });

    // RentalHandoverRecord：owner 参与者注销臂（owner=owner）
    await rawClient!.rentalHandoverRecord.create({
      data: {
        orderId: orderOwnerIsTarget.id,
        photos: [],
        accessories: "私人配件备注",
        currentCondition: "私人现状说明",
        knownIssues: "私人问题说明",
      },
    });

    // renter 侧文本：counterpart 拥有订单、owner 是租客 → renterNote 归属 owner
    const orderTargetIsRenter = await createRentalOrder({
      ownerId: counterpart.id,
      renterId: owner.id,
      listingId: rentalListing.id,
      renterNote: "private-renter-note",
      status: "COMPLETED",
    });
    // RentalHandoverRecord：renter 参与者注销臂（renter=owner）
    await rawClient!.rentalHandoverRecord.create({
      data: {
        orderId: orderTargetIsRenter.id,
        photos: [],
        accessories: "租客侧配件备注",
        currentCondition: "租客侧现状说明",
        knownIssues: "租客侧问题说明",
      },
    });

    await eraseAccount(owner.id);

    // ERASE-SCHOOL-01 / R4-01：schoolName 非空列哨兵
    const erasedOwner = await rawClient!.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(erasedOwner.schoolName).toBe("已注销用户");
    expect(erasedOwner.schoolName).not.toContain("DO-NOT-SURVIVE");

    // listing 文本 REDACT / 引用 CLEAR；结构字段保留
    const erasedRentalListing = await rawClient!.rentalListing.findUniqueOrThrow({
      where: { id: rentalListing.id },
    });
    expect(erasedRentalListing.title).toBe(ERASED_MARKER);
    expect(erasedRentalListing.description).toBe(ERASED_MARKER);
    expect(erasedRentalListing.pickupLocation).toBe(ERASED_MARKER);
    expect(erasedRentalListing.returnLocation).toBe(ERASED_MARKER);
    expect(erasedRentalListing.brand).toBeNull();
    expect(erasedRentalListing.model).toBeNull();
    expect(erasedRentalListing.usageRules).toBeNull();
    expect(erasedRentalListing.damagePolicy).toBeNull();
    expect(erasedRentalListing.overduePolicy).toBeNull();
    expect(erasedRentalListing.price.toFixed(2)).toBe("10.00");
    expect(erasedRentalListing.status).toBe("OFFLINE");
    expect(await rawClient!.rentalListingImage.count({ where: { rentalListingId: rentalListing.id } })).toBe(0);

    const erasedProduct = await rawClient!.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(erasedProduct.title).toBe(ERASED_MARKER);
    expect(erasedProduct.description).toBe(ERASED_MARKER);
    expect(erasedProduct.locationText).toBe(ERASED_MARKER);
    expect(erasedProduct.price.toFixed(2)).toBe("3.00");
    expect(erasedProduct.status).toBe("OFFLINE");
    expect(await rawClient!.productImage.count({ where: { productId: product.id } })).toBe(0);

    const erasedService = await rawClient!.serviceListing.findUniqueOrThrow({
      where: { id: serviceListing.id },
    });
    expect(erasedService.title).toBe(ERASED_MARKER);
    expect(erasedService.description).toBe(ERASED_MARKER);
    expect(erasedService.locationText).toBe(ERASED_MARKER);
    expect(erasedService.availableSchedule).toBeNull();
    expect(erasedService.coverImageUrl).toBeNull();

    const erasedErrand = await rawClient!.errandTask.findUniqueOrThrow({ where: { id: errandTask.id } });
    expect(erasedErrand.title).toBe(ERASED_MARKER);
    expect(erasedErrand.description).toBe(ERASED_MARKER);
    expect(erasedErrand.pickupLocation).toBe(ERASED_MARKER);
    expect(erasedErrand.deliveryLocation).toBe(ERASED_MARKER);
    expect(erasedErrand.contactNote).toBeNull();
    expect(erasedErrand.reward.toFixed(2)).toBe("2.00");
    expect(erasedErrand.status).toBe("CANCELLED");

    // BlockedUser：reason 清，relation 行保留
    const blockedRow = await rawClient!.blockedUser.findFirstOrThrow({
      where: { blockerId: owner.id },
    });
    expect(blockedRow.reason).toBeNull();

    // rental terminal 文本：owner 归属（claim/extension/return/unavailable）
    const erasedClaim = await rawClient!.rentalDamageClaim.findFirstOrThrow({
      where: { orderId: orderOwnerIsTarget.id },
    });
    expect(erasedClaim.damageDescription).toBe(ERASED_MARKER);
    expect(erasedClaim.photos).toEqual([]);

    const erasedExtension = await rawClient!.rentalExtensionRequest.findFirstOrThrow({
      where: { orderId: orderOwnerIsTarget.id },
    });
    expect(erasedExtension.ownerNote).toBeNull();

    const erasedReturn = await rawClient!.rentalReturnRecord.findFirstOrThrow({
      where: { orderId: orderOwnerIsTarget.id },
    });
    expect(erasedReturn.inspectionNote).toBeNull();

    const erasedUnavailable = await rawClient!.rentalUnavailablePeriod.findFirstOrThrow({
      where: { rentalListingId: rentalListing.id },
    });
    expect(erasedUnavailable.reason).toBeNull();
    expect(erasedUnavailable.startDate).toBeTruthy();

    // renter 归属：owner 作为租客的 renterNote 清空
    const renterOrder = await rawClient!.rentalOrder.findUniqueOrThrow({
      where: { id: orderTargetIsRenter.id },
    });
    expect(renterOrder.renterNote).toBeNull();

    // §8/§18：handover free text 双臂（owner 注销 / renter 注销）均清空
    const handoverOwnerArm = await rawClient!.rentalHandoverRecord.findUniqueOrThrow({
      where: { orderId: orderOwnerIsTarget.id },
    });
    expect(handoverOwnerArm.accessories).toBeNull();
    expect(handoverOwnerArm.currentCondition).toBeNull();
    expect(handoverOwnerArm.knownIssues).toBeNull();
    const handoverRenterArm = await rawClient!.rentalHandoverRecord.findUniqueOrThrow({
      where: { orderId: orderTargetIsRenter.id },
    });
    expect(handoverRenterArm.accessories).toBeNull();
    expect(handoverRenterArm.currentCondition).toBeNull();
    expect(handoverRenterArm.knownIssues).toBeNull();

    // §10/§18：PRODUCT/SERVICE/RENTAL 资产（含 PUBLIC）→ PENDING_DELETE
    for (const assetId of [rentalImageAsset.id, productAsset.id, serviceAsset.id]) {
      const asset = await rawClient!.uploadedAsset.findUniqueOrThrow({ where: { id: assetId } });
      expect(asset.status).toBe("PENDING_DELETE");
    }
  });

  it("FINAL CLOSURE A/B/C：meetingLocation buyer 归属 + snapshot owner REDACT + SECONDARY-04", async () => {
    const { eraseAccount } = await import("@/lib/privacy/account-erasure");
    const { createRentalOrderTx } = await import("@/lib/rental-order-machine");
    const { withTransaction } = await import("@/lib/prisma");

    const buyer = await createFixtureUser("FC 买家");
    const seller = await createFixtureUser("FC 卖家");
    const owner = await createFixtureUser("FC 出租者");
    const renter = await createFixtureUser("FC 租客");
    const ownerB = await createFixtureUser("FC 出租者B");
    for (const u of [buyer, seller, owner, renter, ownerB]) {
      await createActiveMembership(u.id);
    }

    // ---- BLOCKER A fixture：buyer-authored meetingLocation ----
    const product = await rawClient!.product.create({
      data: {
        title: RUN_TAG + " FC商品",
        description: "FC描述",
        price: "6.00",
        locationText: "北门",
        condition: "LIKE_NEW",
        sellerId: seller.id,
        campusId,
        categoryId: productCategoryRef.id,
      },
    });
    productIds.push(product.id);
    const fcOrder = await rawClient!.order.create({
      data: {
        orderNo: `GOFC${RUN_TAG.slice(-6)}`,
        type: "PRODUCT",
        status: "COMPLETED",
        paymentStatus: "OFFLINE_PENDING",
        amount: "6.00",
        meetingLocation: "宿舍A栋301-DO-NOT-SURVIVE",
        note: null,
        buyerId: buyer.id,
        sellerId: seller.id,
        productId: product.id,
      },
    });
    orderIds.push(fcOrder.id);

    // ---- BLOCKER B/C fixture：owner listing → createRentalOrderTx snapshot
    //      + listing-title secondary-copy notification ----
    const listingA = await createRentalListing(owner.id);
    await rawClient!.rentalListing.update({
      where: { id: listingA.id },
      data: {
        title: "PRIVATE-LISTING-TITLE-DO-NOT-COPY",
        pickupLocation: "出租者宿舍B栋201",
        returnLocation: "出租者宿舍B栋202",
      },
    });
    const listingB = await createRentalListing(ownerB.id);

    void renter;

    // renter=renter 经生产路径下单（snapshot 形成 + owner 收到通知）
    const orderA = await withTransaction((tx) =>
      createRentalOrderTx(tx, {
        rentalListingId: listingA.id,
        startTime: new Date(Date.now() + 24 * 3600_000),
        endTime: new Date(Date.now() + 30 * 3600_000),
        quantity: 1,
        userId: renter.id,
      }),
    );
    expect("error" in orderA ? false : true).toBe(true);
    const orderAId = (orderA as { orderId: string }).orderId;
    rentalOrderIds.push(orderAId);

    // renter=owner 经生产路径在 ownerB 的 listing 下单（owner 注销臂的对照：
    // ownerA 仅是 renter，ownerB 的 snapshot 不得被清）
    const orderB = await withTransaction((tx) =>
      createRentalOrderTx(tx, {
        rentalListingId: listingB.id,
        startTime: new Date(Date.now() + 24 * 3600_000),
        endTime: new Date(Date.now() + 30 * 3600_000),
        quantity: 1,
        userId: owner.id,
      }),
    );
    const orderBId = (orderB as { orderId: string }).orderId;
    rentalOrderIds.push(orderBId);

    const snapshotsBefore = await rawClient!.rentalOrder.findUniqueOrThrow({
      where: { id: orderAId },
      select: {
        pickupLocationSnapshot: true,
        returnLocationSnapshot: true,
        rentalAmount: true,
        status: true,
      },
    });
    expect(snapshotsBefore.pickupLocationSnapshot).toBe("出租者宿舍B栋201");
    expect(snapshotsBefore.returnLocationSnapshot).toBe("出租者宿舍B栋202");

    // SECONDARY-04：owner 收到的通知绝不携带 listing title 原文
    const ownerNotifications = await rawClient!.notification.findMany({
      where: { userId: owner.id, type: "RENTAL", title: "收到新的租赁申请" },
    });
    expect(ownerNotifications.length).toBeGreaterThanOrEqual(1);
    for (const notification of ownerNotifications) {
      expect(notification.content).not.toContain("PRIVATE-LISTING-TITLE-DO-NOT-COPY");
      expect(notification.content).toBe("你的出租物品收到新的租赁申请，请前往出租订单中心处理。");
    }

    // ---- erase buyer：meetingLocation 清零（BLOCKER A 执行） ----
    await eraseAccount(buyer.id);
    const orderAfterBuyerErase = await rawClient!.order.findUniqueOrThrow({
      where: { id: fcOrder.id },
    });
    expect(orderAfterBuyerErase.meetingLocation).toBeNull();
    // 卖家注销才会清歧义 note/cancelReason；buyer 注销路径本轮仅断言
    // meetingLocation 未被 seller 侧逻辑误清（结构对照）
    expect(orderAfterBuyerErase.amount.toFixed(2)).toBe("6.00");

    // 终局化两个订单（erase 前置：active rental order 会阻断注销）
    await rawClient!.rentalOrder.updateMany({
      where: { id: { in: [orderAId, orderBId] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    // ---- erase owner：own snapshot REDACT；他人 listing snapshot 不动 ----
    await eraseAccount(owner.id);

    const orderAAfter = await rawClient!.rentalOrder.findUniqueOrThrow({ where: { id: orderAId } });
    expect(orderAAfter.pickupLocationSnapshot).toBe(ERASED_MARKER);
    expect(orderAAfter.returnLocationSnapshot).toBe(ERASED_MARKER);
    // 交易结构不变
    expect(orderAAfter.rentalAmount.toFixed(2)).toBe(snapshotsBefore.rentalAmount.toFixed(2));
    // 终局化后的结构状态保持（不被 erasure 改写）
    expect(orderAAfter.status).toBe("COMPLETED");

    // ownerA 在 orderB 只是 renter——ownerB 的 listing snapshot 不得被清
    const orderBAfter = await rawClient!.rentalOrder.findUniqueOrThrow({ where: { id: orderBId } });
    expect(orderBAfter.pickupLocationSnapshot).toBe("北门");
    expect(orderBAfter.returnLocationSnapshot).toBe("北门");
  });

  it("ASSET-03：profile 头像替换的旧资源标记在同一事务内（回滚 = 零标记）", async () => {
    const { updateOwnProfileTx } = await import("@/lib/user/profile-service");
    const { withTransaction } = await import("@/lib/prisma");
    const { buildPublicObjectUrl } = await import("@/lib/storage");

    const user = await createFixtureUser("RB04 头像替换");
    await createActiveMembership(user.id);

    const oldAsset = await createAsset({
      ownerId: user.id,
      category: "AVATAR",
      access: "PUBLIC",
      status: "ATTACHED",
      originalFileName: "old.png",
    });
    const newAsset = await createAsset({
      ownerId: user.id,
      category: "AVATAR",
      access: "PUBLIC",
      status: "UPLOADED",
      originalFileName: "new.png",
    });
    await rawClient!.user.update({
      where: { id: user.id },
      data: { avatarUrl: `asset:${oldAsset.id}` },
    });

    integrationRequireUser.mockResolvedValue({ id: user.id, role: "STUDENT" });

    // happy path：USER 锁事务内 fresh previous → 更新 → 旧资产 PENDING_DELETE
    const result = await withTransaction((tx) =>
      updateOwnProfileTx(tx, user.id, {
        name: "改名后",
        bio: "",
        college: "",
        grade: "",
        phone: "",
        avatarToken: `asset:${newAsset.id}`,
      }),
    );
    // PUBLIC avatar 的规范业务值 = 公开 URL（canonicalAssetValue）
    expect(result.avatarUrl).toBe(buildPublicObjectUrl(newAsset.objectKey));
    expect(result.replacedAssetsMarkedForDeletion).toBe(1);
    expect((await rawClient!.uploadedAsset.findUniqueOrThrow({ where: { id: oldAsset.id } })).status).toBe("PENDING_DELETE");
    expect((await rawClient!.uploadedAsset.findUniqueOrThrow({ where: { id: newAsset.id } })).status).toBe("ATTACHED");

    // rollback path：事务中途失败 → 替换标记随事务回滚（无半提交状态）
    const rollbackAsset = await createAsset({
      ownerId: user.id,
      category: "AVATAR",
      access: "PUBLIC",
      status: "UPLOADED",
      originalFileName: "rollback.png",
    });
    await expect(
      withTransaction(async (tx) => {
        await updateOwnProfileTx(tx, user.id, {
          name: "回滚名",
          bio: "",
          college: "",
          grade: "",
          phone: "",
          avatarToken: `asset:${rollbackAsset.id}`,
        });
        throw new Error("forced rollback");
      }),
    ).rejects.toThrow("forced rollback");

    const userAfter = await rawClient!.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(userAfter.name).toBe("改名后");
    expect(userAfter.avatarUrl).toBe(buildPublicObjectUrl(newAsset.objectKey));
    expect((await rawClient!.uploadedAsset.findUniqueOrThrow({ where: { id: rollbackAsset.id } })).status).toBe("UPLOADED");
  });

  it("ASSET-04：认证材料重提交的旧证据标记在 canonical lifecycle 事务内", async () => {
    const { submitMembershipVerification } = await import("@/lib/campus/verification-service");

    const user = await createFixtureUser("RB04 认证重提交");
    const resubMembership = await createActiveMembership(user.id);

    const oldEvidence = await createAsset({
      ownerId: user.id,
      category: "VERIFICATION",
      access: "PRIVATE",
      status: "ATTACHED",
      originalFileName: "old-card.png",
    });
    const newEvidence = await createAsset({
      ownerId: user.id,
      category: "VERIFICATION",
      access: "PRIVATE",
      status: "UPLOADED",
      originalFileName: "new-card.png",
    });

    const verification = await rawClient!.userVerification.create({
      data: {
        userId: user.id,
        membershipId: resubMembership.id,
        schoolName: "示例大学",
        campusName: "主校区",
        studentIdLast4: "1234",
        studentCardImage: `asset:${oldEvidence.id}`,
        status: "REJECTED",
        submittedAt: new Date(),
        reviewDueAt: new Date(Date.now() + 48 * 3600_000),
      },
    });
    verificationIds.push(verification.id);

    await submitMembershipVerification({
      userId: user.id,
      schoolName: "示例大学",
      campusName: "主校区",
      studentIdLast4: "1234",
      studentCardImageToken: `asset:${newEvidence.id}`,
    });

    expect((await rawClient!.uploadedAsset.findUniqueOrThrow({ where: { id: oldEvidence.id } })).status).toBe("PENDING_DELETE");
    expect((await rawClient!.uploadedAsset.findUniqueOrThrow({ where: { id: newEvidence.id } })).status).toBe("ATTACHED");
    const resubmitted = await rawClient!.userVerification.findUniqueOrThrow({ where: { userId: user.id } });
    expect(resubmitted.studentCardImage).toBe(`asset:${newEvidence.id}`);
    expect(resubmitted.status).toBe("PENDING");
  });

  it("SECONDARY-01：REJECTED 通知不含 reviewNote 原文（真 RBAC 审核路径）", async () => {
    const { decideMembershipVerification } = await import("@/lib/campus/verification-service");

    const target = await createFixtureUser("RB04 认证申请人");
    const reviewer = await createFixtureUser("RB04 审核员");
    const sec1Membership = await createActiveMembership(target.id);

    const verification = await rawClient!.userVerification.create({
      data: {
        userId: target.id,
        membershipId: sec1Membership.id,
        schoolName: "示例大学",
        campusName: "主校区",
        studentIdLast4: "1234",
        studentCardImage: "asset:sec1-evidence",
        status: "PENDING",
        submittedAt: new Date(),
        reviewDueAt: new Date(Date.now() + 48 * 3600_000),
      },
    });
    verificationIds.push(verification.id);

    // 审核授权：ad-hoc GLOBAL role + verification.review permission
    const role = await rawClient!.role.create({
      data: {
        key: `${RUN_TAG}_REVIEWER`,
        name: `${RUN_TAG}_REVIEWER`,
        scope: "GLOBAL",
        isSystem: false,
        rolePermissions: {
          create: [{ permission: { connect: { key: "verification.review" } } }],
        },
      },
    });
    adHocRoleIds.push(role.id);
    const assignment = await rawClient!.userRoleAssignment.create({
      data: { userId: reviewer.id, roleId: role.id, campusId: null, scopeKey: "GLOBAL" },
    });
    assignmentIds.push(assignment.id);

    const REVIEW_NOTE = "复审内部原因Y";
    await decideMembershipVerification({
      actorId: reviewer.id,
      verificationId: verification.id,
      decision: "REJECTED",
      reviewNote: REVIEW_NOTE,
      reasonCode: "VERIFICATION_MATERIALS_INVALID",
    });

    // 权威列保留 reviewNote
    const decided = await rawClient!.userVerification.findUniqueOrThrow({ where: { id: verification.id } });
    expect(decided.reviewNote).toBe(REVIEW_NOTE);

    // 通知 generic copy：绝无 reviewNote 原文
    const notifications = await rawClient!.notification.findMany({ where: { userId: target.id } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.content).not.toContain(REVIEW_NOTE);
    expect(notifications[0]!.content).toContain("未通过");
  });

  it("SECONDARY-02/03：rental reject 原因保留在权威列，status log / notification 为 generic copy", async () => {
    const { rejectRentalOrderTx } = await import("@/lib/rental-order-machine");
    const { withTransaction } = await import("@/lib/prisma");

    const owner = await createFixtureUser("RB04 拒单出租者");
    const renter = await createFixtureUser("RB04 拒单租客");
    await createActiveMembership(owner.id);
    await createActiveMembership(renter.id);

    const listing = await createRentalListing(owner.id);
    const order = await createRentalOrder({
      ownerId: owner.id,
      renterId: renter.id,
      listingId: listing.id,
      status: "PENDING_APPROVAL",
    });

    const RAW_REASON = "拒单原始原因Z";
    const outcome = await withTransaction((tx) =>
      rejectRentalOrderTx(tx, { orderId: order.id, userId: owner.id, rejectReason: RAW_REASON }),
    );
    expect(outcome).toEqual({ success: true });

    // 权威列保留原始原因
    const rejected = await rawClient!.rentalOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(rejected.cancellationNote).toBe(RAW_REASON);
    expect(rejected.cancellationReason).toBe("OTHER");

    // status log = generic copy
    const logs = await rawClient!.rentalOrderStatusLog.findMany({ where: { orderId: order.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.note).toBe("出租者拒绝了租赁申请");
    expect(logs[0]!.note).not.toContain(RAW_REASON);

    // notification = generic copy
    const notifications = await rawClient!.notification.findMany({ where: { userId: renter.id } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.content).not.toContain(RAW_REASON);
    expect(notifications[0]!.content).toContain("未通过");
  });
});
