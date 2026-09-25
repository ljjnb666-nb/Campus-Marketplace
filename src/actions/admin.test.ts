import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  revalidatePath,
  requireAdmin,
  reportUpdate,
  productCategoryCreate,
  productCategoryUpdate,
  errandCategoryCreate,
  errandCategoryUpdate,
  serviceCategoryCreate,
  serviceCategoryUpdate,
  moderationKeywordCreate,
  moderationKeywordUpdate,
  userVerificationUpdate,
  userFindUnique,
  userUpdate,
  productUpdate,
  errandTaskUpdate,
  serviceListingUpdate,
  adminLogCreate,
  createNotification,
  applyVerificationAssetRetention,
  transactionMock,
  decideMembershipVerification,
  suspendAccount,
  reinstateAccount,
  applyReportReviewTx,
  reviewReportInGovernance,
  reportQueryRaw,
  upsertCategoryInGovernance,
  toggleCategoryStatusInGovernance,
  upsertModerationKeywordInGovernance,
  toggleModerationKeywordStatusInGovernance,
  resetModerationKeywordCache,
} = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  requireAdmin: vi.fn(),
  reportUpdate: vi.fn(),
  productCategoryCreate: vi.fn(),
  productCategoryUpdate: vi.fn(),
  errandCategoryCreate: vi.fn(),
  errandCategoryUpdate: vi.fn(),
  serviceCategoryCreate: vi.fn(),
  serviceCategoryUpdate: vi.fn(),
  moderationKeywordCreate: vi.fn(),
  moderationKeywordUpdate: vi.fn(),
  userVerificationUpdate: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  productUpdate: vi.fn(),
  errandTaskUpdate: vi.fn(),
  serviceListingUpdate: vi.fn(),
  adminLogCreate: vi.fn(),
  createNotification: vi.fn(),
  applyVerificationAssetRetention: vi.fn(),
  transactionMock: vi.fn(),
  decideMembershipVerification: vi.fn(),
  suspendAccount: vi.fn(),
  reinstateAccount: vi.fn(),
  applyReportReviewTx: vi.fn(),
  reviewReportInGovernance: vi.fn(),
  reportQueryRaw: vi.fn(),
  upsertCategoryInGovernance: vi.fn(),
  toggleCategoryStatusInGovernance: vi.fn(),
  upsertModerationKeywordInGovernance: vi.fn(),
  toggleModerationKeywordStatusInGovernance: vi.fn(),
  resetModerationKeywordCache: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath,
}));

vi.mock("@/lib/campus/verification-service", () => ({
  decideMembershipVerification,
}));

vi.mock("@/lib/enforcement/account-enforcement-service", () => ({
  suspendAccount,
  reinstateAccount,
}));

vi.mock("@/lib/enforcement/report-projection", () => ({
  applyReportReviewTx,
}));

// Phase 7E：legacy reviewReport 是 canonical 服务的薄 adapter——
// mock 面跟随 mutation authority（FR01 后 canonical 服务自带 actor subject
// lock，stub 事务无法承载，域行为由 report-review-service/集成测试覆盖）。
vi.mock("@/lib/reports/report-review-service", () => ({
  reviewReportInGovernance,
}));

// RB-05：Category/Keyword 的 mutation authority 归 canonical governance
// service——本文件只测 action adapter 合同（会话/参数透传/缓存时序/错误面），
// 域行为由 admin-configuration-service 单测与集成竞态覆盖。
vi.mock("@/lib/governance/admin-configuration-service", () => ({
  upsertCategoryInGovernance,
  toggleCategoryStatusInGovernance,
  upsertModerationKeywordInGovernance,
  toggleModerationKeywordStatusInGovernance,
}));

vi.mock("@/lib/moderation", () => ({
  resetModerationKeywordCache,
}));

vi.mock("@/lib/server-auth", () => ({
  requireAdmin,
}));

vi.mock("@/repositories/notification-repository", () => ({
  createNotification,
}));

vi.mock("@/lib/upload", () => ({
  applyVerificationAssetRetention,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    productCategory: {
      create: productCategoryCreate,
      update: productCategoryUpdate,
    },
    errandCategory: {
      create: errandCategoryCreate,
      update: errandCategoryUpdate,
    },
    serviceCategory: {
      create: serviceCategoryCreate,
      update: serviceCategoryUpdate,
    },
    moderationKeyword: {
      create: moderationKeywordCreate,
      update: moderationKeywordUpdate,
    },
    user: {
      findUnique: userFindUnique,
      update: userUpdate,
    },
    userVerification: {
      update: userVerificationUpdate,
    },
    product: {
      update: productUpdate,
    },
    errandTask: {
      update: errandTaskUpdate,
    },
    serviceListing: {
      update: serviceListingUpdate,
    },
    adminLog: {
      create: adminLogCreate,
    },
    $transaction: transactionMock,
  },
  withTransaction: transactionMock,
}));

import {
  reviewReport,
  reviewVerification,
  toggleErrandCategoryStatus,
  toggleModerationKeywordStatus,
  toggleProductCategoryStatus,
  toggleServiceCategoryStatus,
  toggleUserStatus,
  upsertErrandCategory,
  upsertModerationKeyword,
  upsertProductCategory,
  upsertServiceCategory,
} from "@/actions/admin";

describe("admin actions", () => {
  beforeEach(() => {
    revalidatePath.mockReset();
    requireAdmin.mockReset();
    reportUpdate.mockReset();
    productCategoryCreate.mockReset();
    productCategoryUpdate.mockReset();
    errandCategoryCreate.mockReset();
    errandCategoryUpdate.mockReset();
    serviceCategoryCreate.mockReset();
    serviceCategoryUpdate.mockReset();
    moderationKeywordCreate.mockReset();
    moderationKeywordUpdate.mockReset();
    userVerificationUpdate.mockReset();
    userFindUnique.mockReset();
    userUpdate.mockReset();
    productUpdate.mockReset();
    errandTaskUpdate.mockReset();
    serviceListingUpdate.mockReset();
    adminLogCreate.mockReset();
    createNotification.mockReset();
    applyVerificationAssetRetention.mockReset().mockResolvedValue(0);
    decideMembershipVerification.mockReset().mockResolvedValue({});
    suspendAccount.mockReset();
    reinstateAccount.mockReset();
    reportQueryRaw.mockReset().mockResolvedValue([
      { id: "report-1", status: "OPEN", reporterId: "user-2" },
    ]);
    applyReportReviewTx.mockReset().mockResolvedValue({
      reportId: "report-1",
      status: "RESOLVED",
      reporterId: "user-2",
    });
    reviewReportInGovernance.mockReset().mockResolvedValue({
      reportId: "report-1",
      status: "RESOLVED",
      reporterId: "user-2",
      caseId: "case-1",
      reopened: false,
      dueAt: new Date("2026-09-18T00:00:00.000Z"),
    });
    upsertCategoryInGovernance.mockReset().mockResolvedValue({ categoryId: "category-new", created: true });
    toggleCategoryStatusInGovernance.mockReset().mockResolvedValue({ categoryId: "category-1", isActive: false });
    upsertModerationKeywordInGovernance.mockReset().mockResolvedValue({ keywordId: "keyword-new", created: true });
    toggleModerationKeywordStatusInGovernance.mockReset().mockResolvedValue({ keywordId: "keyword-1", isEnabled: true });
    resetModerationKeywordCache.mockReset();
    transactionMock.mockReset();
    transactionMock.mockImplementation(async (callback) =>
      callback({
        $queryRaw: reportQueryRaw,
        adminLog: {
          create: adminLogCreate,
        },
        userVerification: {
          update: userVerificationUpdate,
        },
        user: {
          update: userUpdate,
        },
        product: {
          update: productUpdate,
        },
        errandTask: {
          update: errandTaskUpdate,
        },
        serviceListing: {
          update: serviceListingUpdate,
        },
      }),
    );

    requireAdmin.mockResolvedValue({ id: "admin-1", role: "ADMIN" });
  });

  it("passes review through to the canonical governance service（Phase 7E FR01 薄 adapter）", async () => {
    const formData = new FormData();
    formData.set("reportId", "report-1");
    formData.set("status", "IN_REVIEW");
    formData.set("handledNote", "已转交值班管理员复核");

    await reviewReport(formData);

    // 通知文案合同归 canonical 服务所有（其单测/集成覆盖）；本层仅断言透传
    expect(reviewReportInGovernance).toHaveBeenCalledWith({
      actorId: "admin-1",
      reportId: "report-1",
      status: "IN_REVIEW",
      handledNote: "已转交值班管理员复核",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/governance/reports");
  });

  it("returns an error state and skips the transaction when report input is invalid", async () => {
    const formData = new FormData();
    formData.set("reportId", "report-1");
    formData.set("status", "PENDING");

    const result = await reviewReport(formData);

    expect(result).toEqual({ success: false, error: "参数无效" });
    expect(transactionMock).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("delegates errand category creation to the canonical governance service（RB-05 薄 adapter）", async () => {
    const formData = new FormData();
    formData.set("name", "代取快递");
    formData.set("slug", "pickup");
    formData.set("description", "快递代取类任务");
    formData.set("sortOrder", "2");
    formData.set("isActive", "true");

    await upsertErrandCategory(formData);

    // actorId 只能来自 requireAdmin 的 session/DB 校验，FormData 不参与身份
    expect(upsertCategoryInGovernance).toHaveBeenCalledWith({
      actorId: "admin-1",
      kind: "ERRAND",
      categoryId: undefined,
      name: "代取快递",
      slug: "pickup",
      description: "快递代取类任务",
      sortOrder: 2,
      isActive: true,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/categories");
    expect(revalidatePath).toHaveBeenCalledWith("/errands");
  });

  it("delegates errand category updates with the categoryId passthrough", async () => {
    const formData = new FormData();
    formData.set("categoryId", "errand-category-1");
    formData.set("name", "代取快递");
    formData.set("slug", "pickup");
    formData.set("description", "");
    formData.set("sortOrder", "2");
    formData.set("isActive", "true");

    await upsertErrandCategory(formData);

    expect(upsertCategoryInGovernance).toHaveBeenCalledWith({
      actorId: "admin-1",
      kind: "ERRAND",
      categoryId: "errand-category-1",
      name: "代取快递",
      slug: "pickup",
      description: null,
      sortOrder: 2,
      isActive: true,
    });
  });

  it("delegates product category creation through the shared adapter", async () => {
    const formData = new FormData();
    formData.set("name", "教材资料");
    formData.set("slug", "books");
    formData.set("description", "教材与笔记");
    formData.set("sortOrder", "1");
    formData.set("isActive", "true");

    await upsertProductCategory(formData);

    expect(upsertCategoryInGovernance).toHaveBeenCalledWith({
      actorId: "admin-1",
      kind: "PRODUCT",
      categoryId: undefined,
      name: "教材资料",
      slug: "books",
      description: "教材与笔记",
      sortOrder: 1,
      isActive: true,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/categories");
    expect(revalidatePath).toHaveBeenCalledWith("/products");
  });

  it("returns an error state when category input is invalid", async () => {
    const formData = new FormData();
    formData.set("name", "");
    formData.set("slug", "pickup");
    formData.set("sortOrder", "2");
    formData.set("isActive", "true");

    const result = await upsertErrandCategory(formData);

    expect(result).toEqual({ success: false, error: "参数无效" });
    expect(upsertCategoryInGovernance).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("delegates errand category status toggles to the canonical service", async () => {
    const formData = new FormData();
    formData.set("categoryId", "errand-category-2");
    formData.set("isActive", "false");

    await toggleErrandCategoryStatus(formData);

    expect(toggleCategoryStatusInGovernance).toHaveBeenCalledWith({
      actorId: "admin-1",
      kind: "ERRAND",
      categoryId: "errand-category-2",
      isActive: false,
    });
  });

  it("delegates service category creation and revalidates the service plaza", async () => {
    const formData = new FormData();
    formData.set("name", "编程辅导");
    formData.set("slug", "coding");
    formData.set("description", "代码答疑与项目辅导");
    formData.set("sortOrder", "3");
    formData.set("isActive", "true");

    await upsertServiceCategory(formData);

    expect(upsertCategoryInGovernance).toHaveBeenCalledWith({
      actorId: "admin-1",
      kind: "SERVICE",
      categoryId: undefined,
      name: "编程辅导",
      slug: "coding",
      description: "代码答疑与项目辅导",
      sortOrder: 3,
      isActive: true,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/services");
  });

  it("delegates service category status toggles to the canonical service", async () => {
    const formData = new FormData();
    formData.set("categoryId", "service-category-2");
    formData.set("isActive", "false");

    await toggleServiceCategoryStatus(formData);

    expect(toggleCategoryStatusInGovernance).toHaveBeenCalledWith({
      actorId: "admin-1",
      kind: "SERVICE",
      categoryId: "service-category-2",
      isActive: false,
    });
  });

  it("returns an error state when toggle input is invalid", async () => {
    const formData = new FormData();
    formData.set("categoryId", "service-category-2");
    formData.set("isActive", "yes");

    const result = await toggleServiceCategoryStatus(formData);

    expect(result).toEqual({ success: false, error: "参数无效" });
    expect(toggleCategoryStatusInGovernance).not.toHaveBeenCalled();
  });

  it("delegates moderation keyword creation with the session admin as creator", async () => {
    const formData = new FormData();
    formData.set("keyword", "代考");
    formData.set("targetType", "GLOBAL");
    formData.set("isEnabled", "true");

    await upsertModerationKeyword(formData);

    expect(upsertModerationKeywordInGovernance).toHaveBeenCalledWith({
      actorId: "admin-1",
      keywordId: undefined,
      keyword: "代考",
      targetType: "GLOBAL",
      isEnabled: true,
    });
    // 缓存失效只在 service COMMIT 成功后发生（RB-05 §24 时序）
    expect(resetModerationKeywordCache).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/keywords");
  });

  it("returns an error state when the keyword is missing", async () => {
    const formData = new FormData();
    formData.set("keyword", "");
    formData.set("targetType", "GLOBAL");
    formData.set("isEnabled", "true");

    const result = await upsertModerationKeyword(formData);

    expect(result).toEqual({ success: false, error: "参数无效" });
    expect(upsertModerationKeywordInGovernance).not.toHaveBeenCalled();
    expect(resetModerationKeywordCache).not.toHaveBeenCalled();
  });

  it("delegates moderation keyword status toggles and resets cache only after success", async () => {
    const formData = new FormData();
    formData.set("keywordId", "keyword-1");
    formData.set("isEnabled", "true");

    await toggleModerationKeywordStatus(formData);

    expect(toggleModerationKeywordStatusInGovernance).toHaveBeenCalledWith({
      actorId: "admin-1",
      keywordId: "keyword-1",
      isEnabled: true,
    });
    expect(resetModerationKeywordCache).toHaveBeenCalledTimes(1);
  });

  it("does not reset the keyword cache when the canonical authority denies（RB-05）", async () => {
    const { rbacError } = await import("@/lib/rbac/errors");
    upsertModerationKeywordInGovernance.mockRejectedValue(
      rbacError("AUTH_PERMISSION_DENIED"),
    );

    const formData = new FormData();
    formData.set("keyword", "代考");
    formData.set("targetType", "GLOBAL");
    formData.set("isEnabled", "true");

    const result = await upsertModerationKeyword(formData);

    // authorization race-loss 映射为安全后台错误，不泄露 permission 结构
    expect(result).toEqual({ success: false, error: "无权执行该操作" });
    expect(resetModerationKeywordCache).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("approves a verification via the central lifecycle service（Phase 6A）", async () => {
    const formData = new FormData();
    formData.set("verificationId", "verification-1");
    formData.set("userId", "user-2");
    formData.set("status", "VERIFIED");
    formData.set("reviewNote", "材料齐全");

    await reviewVerification(formData);

    // 动作只负责会话 + 参数解析，状态机/锁/审计/通知由 service 承担
    expect(decideMembershipVerification).toHaveBeenCalledWith({
      actorId: "admin-1",
      verificationId: "verification-1",
      decision: "VERIFIED",
      reviewNote: "材料齐全",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/verifications");
  });

  it("rejects a verification with the review note as the reason", async () => {
    const formData = new FormData();
    formData.set("verificationId", "verification-1");
    formData.set("userId", "user-2");
    formData.set("status", "REJECTED");
    formData.set("reviewNote", "学生证照片模糊");

    await reviewVerification(formData);

    expect(decideMembershipVerification).toHaveBeenCalledWith({
      actorId: "admin-1",
      verificationId: "verification-1",
      decision: "REJECTED",
      reviewNote: "学生证照片模糊",
    });
  });

  it("surfaces service denial messages instead of generic 500", async () => {
    const { rbacError } = await import("@/lib/rbac/errors");
    decideMembershipVerification.mockRejectedValue(
      rbacError("VERIFICATION_SELF_REVIEW_DENIED"),
    );

    const formData = new FormData();
    formData.set("verificationId", "verification-1");
    formData.set("userId", "admin-1");
    formData.set("status", "VERIFIED");
    formData.set("reviewNote", "");

    const result = await reviewVerification(formData);

    expect(result).toEqual({ success: false, error: "不能审核自己提交的认证申请" });
  });

  it("returns an error state for invalid verification input", async () => {
    const formData = new FormData();
    formData.set("verificationId", "verification-1");
    formData.set("userId", "user-2");
    formData.set("status", "PENDING");

    const result = await reviewVerification(formData);

    expect(result).toEqual({ success: false, error: "参数无效" });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("suspends a student account through the central enforcement service（Phase 6B 薄 adapter）", async () => {
    suspendAccount.mockResolvedValue({ status: "SUSPENDED", alreadyInState: false });

    const formData = new FormData();
    formData.set("userId", "user-2");
    formData.set("nextStatus", "SUSPENDED");

    await toggleUserStatus(formData);

    expect(suspendAccount).toHaveBeenCalledWith({
      actorId: "admin-1",
      targetUserId: "user-2",
      reasonCode: "MANUAL_REVIEW",
      sourceType: "ADMIN_ACTION",
    });
    expect(reinstateAccount).not.toHaveBeenCalled();
    // Repair 1 Blocker C：通知随命令在 service 事务内提交——adapter 不再直接通知
    expect(createNotification).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/admin/users");
  });

  it("refuses to suspend the admin's own account（self-deny 透传）", async () => {
    const { enforcementError } = await import("@/lib/enforcement/errors");
    suspendAccount.mockRejectedValue(enforcementError("ENFORCEMENT_SELF_DENIED"));

    const formData = new FormData();
    formData.set("userId", "admin-1");
    formData.set("nextStatus", "SUSPENDED");

    const result = await toggleUserStatus(formData);

    expect(result).toEqual({ success: false, error: "不能对自己执行该操作" });
  });

  it("refuses privileged targets（RBAC 保护由 service 承担）", async () => {
    const { enforcementError } = await import("@/lib/enforcement/errors");
    suspendAccount.mockRejectedValue(enforcementError("ENFORCEMENT_PRIVILEGED_TARGET"));

    const formData = new FormData();
    formData.set("userId", "admin-2");
    formData.set("nextStatus", "SUSPENDED");

    const result = await toggleUserStatus(formData);

    expect(result).toEqual({ success: false, error: "不能对该账号执行此管理操作" });
  });

  it("refuses to toggle a missing user", async () => {
    const { enforcementError } = await import("@/lib/enforcement/errors");
    reinstateAccount.mockRejectedValue(enforcementError("ENFORCEMENT_TARGET_NOT_FOUND"));

    const formData = new FormData();
    formData.set("userId", "ghost");
    formData.set("nextStatus", "ACTIVE");

    const result = await toggleUserStatus(formData);

    expect(result).toEqual({ success: false, error: "目标不存在" });
  });

  it("is a deterministic no-op when the target is already in state（#51）", async () => {
    suspendAccount.mockResolvedValue({ status: "SUSPENDED", alreadyInState: true });

    const formData = new FormData();
    formData.set("userId", "user-2");
    formData.set("nextStatus", "SUSPENDED");

    const result = await toggleUserStatus(formData);

    expect(result).toEqual({ success: false, error: "账号已处于该状态" });
  });

  // Phase 7C：legacy moderateListing 已删除（治理唯一入口 =
  // /governance/listings canonical moderation service；raw 写入口普查为零，
  // 相关回归移至 src/lib/moderation 与 tests/integration/phase7c-*）。

  it("passes resolved and rejected review decisions through unchanged", async () => {
    const resolvedForm = new FormData();
    resolvedForm.set("reportId", "report-1");
    resolvedForm.set("status", "RESOLVED");
    resolvedForm.set("handledNote", "已下架违规商品");

    await reviewReport(resolvedForm);

    expect(reviewReportInGovernance).toHaveBeenCalledWith({
      actorId: "admin-1",
      reportId: "report-1",
      status: "RESOLVED",
      handledNote: "已下架违规商品",
    });

    const rejectedForm = new FormData();
    rejectedForm.set("reportId", "report-1");
    rejectedForm.set("status", "REJECTED");
    rejectedForm.set("handledNote", "");
    await reviewReport(rejectedForm);

    expect(reviewReportInGovernance).toHaveBeenLastCalledWith({
      actorId: "admin-1",
      reportId: "report-1",
      status: "REJECTED",
      handledNote: null,
    });
  });

  it("returns an error state when review transactions fail", async () => {
    // Phase 6A：审核决定经 central service（事务失败在 service 内发生）；
    // report / listing 处置仍走 withTransaction
    decideMembershipVerification.mockRejectedValue(new Error("db down"));
    transactionMock.mockRejectedValue(new Error("db down"));
    decideMembershipVerification.mockRejectedValue(new Error("db down"));

    const formData = new FormData();
    formData.set("verificationId", "verification-1");
    formData.set("userId", "user-2");
    formData.set("status", "VERIFIED");
    formData.set("reviewNote", "");

    const verificationResult = await reviewVerification(formData);
    expect(verificationResult?.success).toBe(false);

    formData.delete("verificationId");
    formData.set("reportId", "report-1");
    formData.set("status", "IN_REVIEW");
    reviewReportInGovernance.mockRejectedValueOnce(new Error("db down"));
    const reportResult = await reviewReport(formData);
    expect(reportResult?.success).toBe(false);

  });

  it("returns an error state when toggle user status input is invalid", async () => {
    const formData = new FormData();
    formData.set("userId", "user-2");
    formData.set("nextStatus", "BANNED");

    const result = await toggleUserStatus(formData);

    expect(result).toEqual({ success: false, error: "参数无效" });
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("restores a suspended account through the central enforcement service", async () => {
    reinstateAccount.mockResolvedValue({ status: "ACTIVE", alreadyInState: false });

    const formData = new FormData();
    formData.set("userId", "user-2");
    formData.set("nextStatus", "ACTIVE");

    await toggleUserStatus(formData);

    expect(reinstateAccount).toHaveBeenCalledWith({
      actorId: "admin-1",
      targetUserId: "user-2",
      reasonCode: "MANUAL_REVIEW",
      sourceType: "ADMIN_ACTION",
    });
  });

  it("stops protecting targets whose grants were revoked despite role=ADMIN（service 决定放行）", async () => {
    // 授权已撤回的目标不再受 privileged 保护——由 central service 判定放行
    reinstateAccount.mockResolvedValue({ status: "ACTIVE", alreadyInState: false });

    const formData = new FormData();
    formData.set("userId", "user-3");
    formData.set("nextStatus", "ACTIVE");

    const result = await toggleUserStatus(formData);

    expect(result).not.toEqual({ success: false, error: "不能对该账号执行此管理操作" });
  });

  it("routes product and service category creation through the canonical service", async () => {
    const formData = new FormData();
    formData.set("name", "数码设备");
    formData.set("slug", "digital");
    formData.set("description", "数码类商品");
    formData.set("sortOrder", "1");
    formData.set("isActive", "true");

    await upsertProductCategory(formData);

    expect(upsertCategoryInGovernance).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "admin-1", kind: "PRODUCT", slug: "digital" }),
    );

    formData.set("name", "编程辅导");
    formData.set("slug", "coding");
    await upsertServiceCategory(formData);

    expect(upsertCategoryInGovernance).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "admin-1", kind: "SERVICE", slug: "coding" }),
    );
  });

  it("delegates product category status toggles to the canonical service", async () => {
    const formData = new FormData();
    formData.set("categoryId", "category-1");
    formData.set("isActive", "false");

    await toggleProductCategoryStatus(formData);

    expect(toggleCategoryStatusInGovernance).toHaveBeenCalledWith({
      actorId: "admin-1",
      kind: "PRODUCT",
      categoryId: "category-1",
      isActive: false,
    });
  });

  it("delegates moderation keyword updates to the canonical service", async () => {
    const formData = new FormData();
    formData.set("keywordId", "keyword-1");
    formData.set("keyword", "更新后的关键词");
    formData.set("targetType", "GLOBAL");
    formData.set("isEnabled", "true");

    await upsertModerationKeyword(formData);

    expect(upsertModerationKeywordInGovernance).toHaveBeenCalledWith({
      actorId: "admin-1",
      keywordId: "keyword-1",
      keyword: "更新后的关键词",
      targetType: "GLOBAL",
      isEnabled: true,
    });
  });

  it("contains no raw governance prisma writes（RB-05 static raw-write gate）", async () => {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");

    const source = await readFile(
      resolve(process.cwd(), "src/actions/admin.ts"),
      "utf8",
    );

    // legacy 裸写普查为零：Category/Keyword/AdminLog 的唯一 mutation 权威是
    // canonical governance service（域写 + same-tx 审计）
    expect(source).not.toMatch(/prisma\.productCategory/);
    expect(source).not.toMatch(/prisma\.errandCategory/);
    expect(source).not.toMatch(/prisma\.serviceCategory/);
    expect(source).not.toMatch(/prisma\.moderationKeyword/);
    expect(source).not.toMatch(/prisma\.adminLog\.create/);
    // 同理禁止经 delegate 别名/表映射绕过（tx/adminLog 亦不得出现）
    expect(source).not.toMatch(/adminLog/);
  });
});
