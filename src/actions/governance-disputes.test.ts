import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  revalidatePath,
  revalidateOrderViews,
  requireUser,
  loadAuthorizationContext,
  claimDispute,
  releaseDispute,
  resolveDispute,
  closeDispute,
  claimOrderDispute,
  releaseOrderDispute,
  resolveOrderDispute,
  closeOrderDispute,
} = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  revalidateOrderViews: vi.fn(),
  requireUser: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  claimDispute: vi.fn(),
  releaseDispute: vi.fn(),
  resolveDispute: vi.fn(),
  closeDispute: vi.fn(),
  claimOrderDispute: vi.fn(),
  releaseOrderDispute: vi.fn(),
  resolveOrderDispute: vi.fn(),
  closeOrderDispute: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/revalidate", () => ({ revalidateOrderViews }));
vi.mock("@/lib/server-auth", () => ({ requireUser }));
vi.mock("@/lib/rbac/service", () => ({ loadAuthorizationContext }));
vi.mock("@/lib/disputes/dispute-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/disputes/dispute-access")>();
  return { ...actual, deriveDisputeReviewAccess: actual.deriveDisputeReviewAccess };
});
vi.mock("@/lib/disputes/dispute-service", () => ({
  claimDispute,
  releaseDispute,
  resolveDispute,
  closeDispute,
}));
vi.mock("@/lib/disputes/order-dispute-service", () => ({
  claimOrderDispute,
  releaseOrderDispute,
  resolveOrderDispute,
  closeOrderDispute,
}));

import {
  claimGovernanceDispute,
  closeGovernanceDispute,
  releaseGovernanceDispute,
  resolveGovernanceDispute,
} from "@/actions/governance-disputes";
import { disputeError } from "@/lib/disputes/errors";

/**
 * Phase 7G：纠纷 actions 薄适配层合同（validate → 身份 → access fail-fast →
 * canonical 服务 → revalidate；missing/越权统一 deny 文案）。
 */

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) {
    fd.set(k, v);
  }
  return fd;
}

beforeEach(() => {
  for (const fn of [
    requireUser,
    loadAuthorizationContext,
    claimDispute,
    releaseDispute,
    resolveDispute,
    closeDispute,
    claimOrderDispute,
    releaseOrderDispute,
    resolveOrderDispute,
    closeOrderDispute,
    revalidatePath,
    revalidateOrderViews,
  ]) {
    fn.mockReset();
  }
  requireUser.mockResolvedValue({ id: "operator-1" });
  loadAuthorizationContext.mockResolvedValue({
    userId: "operator-1",
    accountActive: true,
    activeCampusIds: ["A"],
    grants: [
      { roleKey: "CAMPUS_DISPUTE_REVIEWER", scope: "CAMPUS", campusId: "A", permissionKeys: ["dispute.review"] },
    ],
  });
});

describe("claimGovernanceDispute / releaseGovernanceDispute", () => {
  it("claim happy path → canonical 服务 + revalidate + outcome", async () => {
    claimDispute.mockResolvedValue({ disputeId: "d1", assignedToId: "operator-1", outcome: "CLAIMED" });

    const result = await claimGovernanceDispute(formData({ disputeId: "d1" }));

    expect(result).toEqual({ success: true, outcome: "CLAIMED" });
    expect(claimDispute).toHaveBeenCalledWith({ actorId: "operator-1", disputeId: "d1" });
    expect(revalidatePath).toHaveBeenCalledWith("/governance/disputes");
    expect(revalidatePath).toHaveBeenCalledWith("/governance/disputes/d1");
  });

  it("零有效 access → 统一 deny（canonical 服务零调用）", async () => {
    loadAuthorizationContext.mockResolvedValue({
      userId: "operator-1",
      accountActive: true,
      activeCampusIds: [],
      grants: [],
    });

    const result = await claimGovernanceDispute(formData({ disputeId: "d1" }));
    expect(result).toEqual({ success: false, error: "没有权限处理该纠纷" });
    expect(claimDispute).not.toHaveBeenCalled();
  });

  it("NOT_FOUND/FORBIDDEN → 统一 deny；ALREADY_CLAIMED → 域内安全文案", async () => {
    claimDispute.mockRejectedValue(disputeError("DISPUTE_NOT_FOUND"));
    expect(await claimGovernanceDispute(formData({ disputeId: "x" }))).toEqual({
      success: false,
      error: "没有权限处理该纠纷",
    });

    claimDispute.mockRejectedValue(disputeError("DISPUTE_ALREADY_CLAIMED"));
    expect(await claimGovernanceDispute(formData({ disputeId: "x" }))).toEqual({
      success: false,
      error: "该纠纷已被其他审核员领用",
    });
  });

  it("参数缺失 → 参数错误（不进入服务）", async () => {
    const result = await claimGovernanceDispute(formData({}));
    expect(result.success).toBe(false);
    expect(claimDispute).not.toHaveBeenCalled();
  });

  it("release happy path", async () => {
    releaseDispute.mockResolvedValue({ disputeId: "d1", assignedToId: null, outcome: "RELEASED" });
    const result = await releaseGovernanceDispute(formData({ disputeId: "d1" }));
    expect(result).toEqual({ success: true, outcome: "RELEASED" });
  });
});

describe("resolveGovernanceDispute / closeGovernanceDispute", () => {
  it("resolve 透传 resolutionCode/action/adminNote", async () => {
    resolveDispute.mockResolvedValue({ disputeId: "d1", status: "RESOLVED", orderStatus: "IN_RENTAL", releasedHolds: 2 });

    const result = await resolveGovernanceDispute(
      formData({ disputeId: "d1", resolutionCode: "MUTUAL_AGREEMENT", resolutionAction: "RESTORE_PREVIOUS", adminNote: "ok" }),
    );

    expect(result.success).toBe(true);
    expect(resolveDispute).toHaveBeenCalledWith({
      actorId: "operator-1",
      disputeId: "d1",
      resolutionCode: "MUTUAL_AGREEMENT",
      resolutionAction: "RESTORE_PREVIOUS",
      adminNote: "ok",
    });
  });

  it("RESTORE_UNAVAILABLE → 域内安全文案（非统一 deny）", async () => {
    resolveDispute.mockRejectedValue(disputeError("DISPUTE_RESTORE_UNAVAILABLE"));
    const result = await resolveGovernanceDispute(
      formData({ disputeId: "d1", resolutionCode: "OTHER", resolutionAction: "RESTORE_PREVIOUS" }),
    );
    expect(result).toEqual({ success: false, error: "无法确定订单纠纷前状态，不能执行恢复" });
  });

  it("release/resolve 零 access → 统一 deny（canonical 服务零调用）", async () => {
    loadAuthorizationContext.mockResolvedValue({
      userId: "operator-1",
      accountActive: true,
      activeCampusIds: [],
      grants: [],
    });
    expect(await releaseGovernanceDispute(formData({ disputeId: "d1" }))).toEqual({
      success: false,
      error: "没有权限处理该纠纷",
    });
    expect(await resolveGovernanceDispute(
      formData({ disputeId: "d1", resolutionCode: "OTHER", resolutionAction: "CLOSE_ORDER" }),
    )).toEqual({ success: false, error: "没有权限处理该纠纷" });
    expect(releaseDispute).not.toHaveBeenCalled();
    expect(resolveDispute).not.toHaveBeenCalled();
  });

  it("release/resolve/close 错误分支：RELEASE_FORBIDDEN 统一 deny；域错误保留文案；非域错误走 fallback", async () => {
    releaseDispute.mockRejectedValue(disputeError("DISPUTE_RELEASE_FORBIDDEN"));
    expect(await releaseGovernanceDispute(formData({ disputeId: "x" }))).toEqual({
      success: false,
      error: "没有权限处理该纠纷",
    });

    closeDispute.mockRejectedValue(disputeError("DISPUTE_INVALID_TRANSITION"));
    expect(
      await closeGovernanceDispute(formData({ disputeId: "d1", resolutionAction: "CLOSE_ORDER" })),
    ).toEqual({ success: false, error: "纠纷当前状态不允许此操作" });

    resolveDispute.mockRejectedValue(new Error("boom"));
    const fallback = await resolveGovernanceDispute(
      formData({ disputeId: "d1", resolutionCode: "OTHER", resolutionAction: "CLOSE_ORDER" }),
    );
    expect(fallback.success).toBe(false);
  });

  it("close 透传 action；非法枚举 → 参数错误", async () => {
    closeDispute.mockResolvedValue({ disputeId: "d1", status: "CLOSED", orderStatus: "CLOSED", releasedHolds: 2 });
    const result = await closeGovernanceDispute(
      formData({ disputeId: "d1", resolutionAction: "CLOSE_ORDER" }),
    );
    expect(result.success).toBe(true);

    const bad = await closeGovernanceDispute(
      formData({ disputeId: "d1", resolutionAction: "NOT_AN_ACTION" }),
    );
    expect(bad.success).toBe(false);
    expect(closeDispute).toHaveBeenCalledTimes(1);
  });
});

/**
 * Phase 8C-02：disputeKind 显式 dispatch（§45-§47, §49, §60）。
 * RENTAL → Rental canonical service only；ORDER → Order canonical service
 * only；wrong kind / missing / 越权统一 deny（anti-oracle）；
 * ORDER terminal 成功 → revalidateOrderViews（locked Order type-FK context）。
 */
describe("governance disputeKind dispatch（Phase 8C-02）", () => {
  it("RENTAL 显式 kind → Rental canonical service only（Order 服务零调用）", async () => {
    claimDispute.mockResolvedValue({ disputeId: "d1", assignedToId: "operator-1", outcome: "CLAIMED" });

    const result = await claimGovernanceDispute(formData({ disputeId: "d1", disputeKind: "RENTAL" }));

    expect(result).toEqual({ success: true, outcome: "CLAIMED" });
    expect(claimDispute).toHaveBeenCalledWith({ actorId: "operator-1", disputeId: "d1" });
    expect(claimOrderDispute).not.toHaveBeenCalled();
  });

  it("ORDER dispatch → claimOrderDispute only（Rental 服务零调用零 mutation）", async () => {
    claimOrderDispute.mockResolvedValue({ disputeId: "od-1", assignedToId: "operator-1", outcome: "CLAIMED" });

    const result = await claimGovernanceDispute(formData({ disputeId: "od-1", disputeKind: "ORDER" }));

    expect(result).toEqual({ success: true, outcome: "CLAIMED" });
    expect(claimOrderDispute).toHaveBeenCalledWith({ actorId: "operator-1", disputeId: "od-1" });
    expect(claimDispute).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/governance/disputes");
    expect(revalidatePath).toHaveBeenCalledWith("/governance/disputes/od-1");
  });

  it("ORDER release dispatch → releaseOrderDispute", async () => {
    releaseOrderDispute.mockResolvedValue({ disputeId: "od-1", assignedToId: null, outcome: "RELEASED" });

    const result = await releaseGovernanceDispute(formData({ disputeId: "od-1", disputeKind: "ORDER" }));

    expect(result).toEqual({ success: true, outcome: "RELEASED" });
    expect(releaseOrderDispute).toHaveBeenCalledWith({ actorId: "operator-1", disputeId: "od-1" });
    expect(releaseDispute).not.toHaveBeenCalled();
  });

  it("ORDER resolve → resolutionCode/action/adminNote 精确透传 + revalidateOrderViews(context)", async () => {
    resolveOrderDispute.mockResolvedValue({
      disputeId: "od-1",
      status: "RESOLVED",
      orderStatus: "ACCEPTED",
      errandStatus: null,
      releasedHolds: 2,
      productId: "product-1",
      serviceListingId: null,
      errandTaskId: null,
    });

    const result = await resolveGovernanceDispute(
      formData({
        disputeId: "od-1",
        disputeKind: "ORDER",
        resolutionCode: "MUTUAL_AGREEMENT",
        resolutionAction: "RESTORE_PREVIOUS",
        adminNote: "核实后恢复",
      }),
    );

    expect(result).toEqual({ success: true });
    expect(resolveOrderDispute).toHaveBeenCalledWith({
      actorId: "operator-1",
      disputeId: "od-1",
      resolutionCode: "MUTUAL_AGREEMENT",
      resolutionAction: "RESTORE_PREVIOUS",
      adminNote: "核实后恢复",
    });
    expect(resolveDispute).not.toHaveBeenCalled();
    expect(revalidateOrderViews).toHaveBeenCalledWith({ productId: "product-1" });
  });

  it("ORDER close → closeOrderDispute + revalidateOrderViews（errand context）", async () => {
    closeOrderDispute.mockResolvedValue({
      disputeId: "od-2",
      status: "CLOSED",
      orderStatus: "CLOSED",
      errandStatus: "CLOSED",
      releasedHolds: 2,
      productId: null,
      serviceListingId: null,
      errandTaskId: "errand-1",
    });

    const result = await closeGovernanceDispute(
      formData({ disputeId: "od-2", disputeKind: "ORDER", resolutionAction: "CLOSE_ORDER" }),
    );

    expect(result).toEqual({ success: true });
    expect(closeOrderDispute).toHaveBeenCalledWith({
      actorId: "operator-1",
      disputeId: "od-2",
      resolutionAction: "CLOSE_ORDER",
      adminNote: null,
    });
    expect(closeDispute).not.toHaveBeenCalled();
    expect(revalidateOrderViews).toHaveBeenCalledWith({ errandId: "errand-1" });
  });

  it("RENTAL resolve/close → Rental 服务 + revalidateOrderViews 零调用", async () => {
    resolveDispute.mockResolvedValue({ disputeId: "d1", status: "RESOLVED", orderStatus: "IN_RENTAL", releasedHolds: 2 });

    await resolveGovernanceDispute(
      formData({ disputeId: "d1", disputeKind: "RENTAL", resolutionCode: "OTHER", resolutionAction: "CLOSE_ORDER" }),
    );

    expect(resolveDispute).toHaveBeenCalledTimes(1);
    expect(resolveOrderDispute).not.toHaveBeenCalled();
    expect(revalidateOrderViews).not.toHaveBeenCalled();
  });

  it("wrong kind（ORDER id 落 NOT_FOUND）→ 统一 deny（两域同文案）", async () => {
    claimOrderDispute.mockRejectedValue(disputeError("DISPUTE_NOT_FOUND"));
    expect(
      await claimGovernanceDispute(formData({ disputeId: "rental-only-id", disputeKind: "ORDER" })),
    ).toEqual({ success: false, error: "没有权限处理该纠纷" });

    claimDispute.mockRejectedValue(disputeError("DISPUTE_NOT_FOUND"));
    expect(
      await claimGovernanceDispute(formData({ disputeId: "order-only-id", disputeKind: "RENTAL" })),
    ).toEqual({ success: false, error: "没有权限处理该纠纷" });
  });

  it("非法 disputeKind 值 → 统一 deny，两域服务零调用", async () => {
    const result = await claimGovernanceDispute(formData({ disputeId: "d1", disputeKind: "xxx" }));

    expect(result).toEqual({ success: false, error: "没有权限处理该纠纷" });
    expect(claimDispute).not.toHaveBeenCalled();
    expect(claimOrderDispute).not.toHaveBeenCalled();
  });

  it("missing disputeKind（legacy Rental form contract）→ RENTAL 服务", async () => {
    releaseDispute.mockResolvedValue({ disputeId: "d1", assignedToId: null, outcome: "RELEASED" });

    await releaseGovernanceDispute(formData({ disputeId: "d1" }));

    expect(releaseDispute).toHaveBeenCalledWith({ actorId: "operator-1", disputeId: "d1" });
    expect(releaseOrderDispute).not.toHaveBeenCalled();
  });

  it("ORDER terminal + 零 reviewer access → 两域服务零调用", async () => {
    loadAuthorizationContext.mockResolvedValue({
      userId: "operator-1",
      accountActive: true,
      activeCampusIds: [],
      grants: [],
    });

    const result = await resolveGovernanceDispute(
      formData({ disputeId: "od-1", disputeKind: "ORDER", resolutionCode: "OTHER", resolutionAction: "CLOSE_ORDER" }),
    );

    expect(result).toEqual({ success: false, error: "没有权限处理该纠纷" });
    expect(resolveOrderDispute).not.toHaveBeenCalled();
    expect(resolveDispute).not.toHaveBeenCalled();
    expect(revalidateOrderViews).not.toHaveBeenCalled();
  });
});
