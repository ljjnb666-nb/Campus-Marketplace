import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ERASED_STALE_SESSION_PRIVACY_ACTION_DENIED：
 * 注销/停用账号的残留旧 JWT 不能执行注销请求等隐私 mutation。
 *
 * 隐私自助操作虽然豁免 consent gate（退出权优先），但账号 active 校验
 * （getVerifiedSession 内 DB 复核 status/deletedAt/erasedAt）永远不可跳过。
 */

const { getVerifiedSession, createAccountDeletionRequest, cancelOwnPendingRequest, isRateLimited } =
  vi.hoisted(() => ({
    getVerifiedSession: vi.fn(),
    createAccountDeletionRequest: vi.fn(),
    cancelOwnPendingRequest: vi.fn(),
    isRateLimited: vi.fn(),
  }));

vi.mock("@/lib/server-auth", () => ({
  getVerifiedSession,
  VERIFIED_SESSION_HTTP_STATUS: {
    UNAUTHENTICATED: 401,
    ACCOUNT_INACTIVE: 401,
    LEGAL_ACCEPTANCE_REQUIRED: 403,
  },
}));

vi.mock("@/lib/privacy/privacy-request-service", () => ({
  createAccountDeletionRequest,
  cancelOwnPendingRequest,
  describeBlockedReason: (code: string | null) => `blocked:${code ?? "unknown"}`,
}));

vi.mock("@/lib/rate-limit", () => ({
  isRateLimited,
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { cancelPrivacyRequest, requestAccountDeletion } from "@/actions/privacy";

function buildDeletionForm(): FormData {
  const formData = new FormData();
  formData.set("confirmation", "注销账号");

  return formData;
}

beforeEach(() => {
  getVerifiedSession.mockReset();
  createAccountDeletionRequest.mockReset();
  cancelOwnPendingRequest.mockReset();
  isRateLimited.mockReset();
  isRateLimited.mockResolvedValue({ limited: false });
  createAccountDeletionRequest.mockResolvedValue({
    status: "COMPLETED",
    request: { id: "req-1", status: "COMPLETED" },
    erasure: { userId: "user-1", erasedAt: new Date() },
  });
});

describe("requestAccountDeletion（ERASED_STALE_SESSION_PRIVACY_ACTION_DENIED）", () => {
  it("denies an erased account's stale JWT without any deletion execution", async () => {
    getVerifiedSession.mockResolvedValue({ ok: false, reason: "ACCOUNT_INACTIVE" });

    const result = await requestAccountDeletion(
      { success: false, message: "" },
      buildDeletionForm(),
    );

    expect(result).toMatchObject({ success: false });
    // 下游破坏性路径零调用
    expect(createAccountDeletionRequest).not.toHaveBeenCalled();
  });

  it("denies unauthenticated submissions", async () => {
    getVerifiedSession.mockResolvedValue({ ok: false, reason: "UNAUTHENTICATED" });

    const result = await requestAccountDeletion(
      { success: false, message: "" },
      buildDeletionForm(),
    );

    expect(result.success).toBe(false);
    expect(createAccountDeletionRequest).not.toHaveBeenCalled();
  });

  it("executes the deletion for an active account with explicit confirmation", async () => {
    getVerifiedSession.mockResolvedValue({
      ok: true,
      user: { id: "user-1", email: "user@x", name: "n", role: "STUDENT" },
    });

    const result = await requestAccountDeletion(
      { success: false, message: "" },
      buildDeletionForm(),
    );

    expect(result).toMatchObject({ success: true, signedOut: true });
    expect(createAccountDeletionRequest).toHaveBeenCalledWith("user-1");
  });

  it("requires the typed confirmation phrase", async () => {
    getVerifiedSession.mockResolvedValue({
      ok: true,
      user: { id: "user-1", email: "user@x", name: "n", role: "STUDENT" },
    });

    const formData = new FormData();
    formData.set("confirmation", "delete");

    const result = await requestAccountDeletion({ success: false, message: "" }, formData);

    expect(result.success).toBe(false);
    expect(createAccountDeletionRequest).not.toHaveBeenCalled();
  });
});

describe("cancelPrivacyRequest（stale session guard）", () => {
  it("denies an inactive account's stale JWT", async () => {
    getVerifiedSession.mockResolvedValue({ ok: false, reason: "ACCOUNT_INACTIVE" });

    const formData = new FormData();
    formData.set("requestId", "req-9");

    const result = await cancelPrivacyRequest({ success: false, message: "" }, formData);

    expect(result.success).toBe(false);
    expect(cancelOwnPendingRequest).not.toHaveBeenCalled();
  });
});
