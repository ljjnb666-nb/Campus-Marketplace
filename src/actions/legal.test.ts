import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ERASED_STALE_SESSION_LEGAL_ACTION_DENIED + RB-03 RECONSENT race-loss：
 * - 注销/停用账号的残留旧 JWT 不能提交协议同意（entry resolver 拒绝）；
 * - entry 时仍 ACTIVE 但 USER 锁内 fresh 复核前 erase/suspend 竞态先提交
 *   （recordReconsentAcceptances 抛 AUTH_ACCOUNT_INACTIVE）→ 必须与入口
 *   失效完全同形："请先登录"，不区分 erased/deleted/suspended/race-lost。
 */

const { getVerifiedSession, recordReconsentAcceptances } = vi.hoisted(() => ({
  getVerifiedSession: vi.fn(),
  recordReconsentAcceptances: vi.fn(),
}));

vi.mock("@/lib/server-auth", () => ({
  getVerifiedSession,
  VERIFIED_SESSION_HTTP_STATUS: {
    UNAUTHENTICATED: 401,
    ACCOUNT_INACTIVE: 401,
    LEGAL_ACCEPTANCE_REQUIRED: 403,
  },
}));

vi.mock("@/lib/legal/policy-service", () => ({
  recordReconsentAcceptances,
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { acceptRequiredPolicies } from "@/actions/legal";

function buildFormData(): FormData {
  const formData = new FormData();
  formData.set("agreeLegal", "on");
  formData.append("acceptedDocumentIds", "doc-terms-2");
  formData.append("acceptedDocumentIds", "doc-privacy-1");
  return formData;
}

beforeEach(() => {
  getVerifiedSession.mockReset();
  recordReconsentAcceptances.mockReset();
  recordReconsentAcceptances.mockResolvedValue({ created: 2, skipped: 0 });
});

describe("acceptRequiredPolicies（ERASED_STALE_SESSION_LEGAL_ACTION_DENIED + RB-03 race-loss）", () => {
  it("denies an erased account's stale JWT without touching acceptance writes", async () => {
    getVerifiedSession.mockResolvedValue({ ok: false, reason: "ACCOUNT_INACTIVE" });

    const result = await acceptRequiredPolicies(
      { success: false, message: "" },
      buildFormData(),
    );

    expect(result).toMatchObject({ success: false });
    // 下游写路径零调用：被吊销的会话不能产生任何同意证据
    expect(recordReconsentAcceptances).not.toHaveBeenCalled();
  });

  it("denies unauthenticated submissions", async () => {
    getVerifiedSession.mockResolvedValue({ ok: false, reason: "UNAUTHENTICATED" });

    const result = await acceptRequiredPolicies(
      { success: false, message: "" },
      buildFormData(),
    );

    expect(result.success).toBe(false);
    expect(recordReconsentAcceptances).not.toHaveBeenCalled();
  });

  it("routes the authoritative write through recordReconsentAcceptances（RB-03）", async () => {
    getVerifiedSession.mockResolvedValue({
      ok: true,
      user: { id: "user-1", email: "user@x", name: "n", role: "STUDENT" },
    });

    const result = await acceptRequiredPolicies(
      { success: false, message: "" },
      buildFormData(),
    );

    expect(result).toMatchObject({ success: true, message: "已同意最新协议" });
    expect(recordReconsentAcceptances).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("RB-03 race-loss：AUTH_ACCOUNT_INACTIVE → 与入口失效同形（请先登录）", async () => {
    getVerifiedSession.mockResolvedValue({
      ok: true,
      user: { id: "user-1", email: "user@x", name: "n", role: "STUDENT" },
    });
    const { RbacError } = await import("@/lib/rbac/errors");
    recordReconsentAcceptances.mockRejectedValue(
      new RbacError("AUTH_ACCOUNT_INACTIVE", "账号当前不可用"),
    );

    const result = await acceptRequiredPolicies(
      { success: false, message: "" },
      buildFormData(),
    );

    expect(result).toEqual({ success: false, message: "请先登录" });
  });

  it("requires the explicit checkbox even for an active account", async () => {
    getVerifiedSession.mockResolvedValue({
      ok: true,
      user: { id: "user-1", email: "user@x", name: "n", role: "STUDENT" },
    });

    const formData = buildFormData();
    formData.delete("agreeLegal");

    const result = await acceptRequiredPolicies({ success: false, message: "" }, formData);

    expect(result).toMatchObject({ success: false, message: "请先勾选同意后再提交" });
    expect(recordReconsentAcceptances).not.toHaveBeenCalled();
  });
});
