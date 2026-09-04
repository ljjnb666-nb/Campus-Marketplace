import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ERASED_STALE_SESSION_LEGAL_ACTION_DENIED：
 * 注销/停用账号的残留旧 JWT 不能提交协议同意。
 *
 * 身份校验收敛在 getVerifiedSession（DB 复核 status/deletedAt/erasedAt）；
 * 本测试锁定 action 层的接线：resolver 拒绝 → action 返回安全拒绝
 * 且不触碰任何 downstream 写路径。
 */

const { getVerifiedSession, recordAcceptances } = vi.hoisted(() => ({
  getVerifiedSession: vi.fn(),
  recordAcceptances: vi.fn(),
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
  recordAcceptances,
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
  recordAcceptances.mockReset();
  recordAcceptances.mockResolvedValue({ created: 2, skipped: 0 });
});

describe("acceptRequiredPolicies（ERASED_STALE_SESSION_LEGAL_ACTION_DENIED）", () => {
  it("denies an erased account's stale JWT without touching acceptance writes", async () => {
    getVerifiedSession.mockResolvedValue({ ok: false, reason: "ACCOUNT_INACTIVE" });

    const result = await acceptRequiredPolicies(
      { success: false, message: "" },
      buildFormData(),
    );

    expect(result).toMatchObject({ success: false });
    // 下游写路径零调用：被吊销的会话不能产生任何同意证据
    expect(recordAcceptances).not.toHaveBeenCalled();
  });

  it("denies unauthenticated submissions", async () => {
    getVerifiedSession.mockResolvedValue({ ok: false, reason: "UNAUTHENTICATED" });

    const result = await acceptRequiredPolicies(
      { success: false, message: "" },
      buildFormData(),
    );

    expect(result.success).toBe(false);
    expect(recordAcceptances).not.toHaveBeenCalled();
  });

  it("proceeds to the policy service for an active account", async () => {
    getVerifiedSession.mockResolvedValue({
      ok: true,
      user: { id: "user-1", email: "user@x", name: "n", role: "STUDENT" },
    });

    const result = await acceptRequiredPolicies(
      { success: false, message: "" },
      buildFormData(),
    );

    expect(result).toMatchObject({ success: true, message: "已同意最新协议" });
    expect(recordAcceptances).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", source: "RECONSENT" }),
    );
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
    expect(recordAcceptances).not.toHaveBeenCalled();
  });
});
