import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireUser,
  createGovernanceCampus,
  updateGovernanceCampusMetadata,
  activateGovernanceCampus,
  deactivateGovernanceCampus,
  createGovernanceVerificationPolicyDraft,
  updateGovernanceVerificationPolicyDraft,
  publishGovernanceVerificationPolicy,
  retireGovernanceVerificationPolicy,
  revalidatePath,
  actionErrorMessage,
} = vi.hoisted(() => ({
  requireUser: vi.fn(),
  createGovernanceCampus: vi.fn(),
  updateGovernanceCampusMetadata: vi.fn(),
  activateGovernanceCampus: vi.fn(),
  deactivateGovernanceCampus: vi.fn(),
  createGovernanceVerificationPolicyDraft: vi.fn(),
  updateGovernanceVerificationPolicyDraft: vi.fn(),
  publishGovernanceVerificationPolicy: vi.fn(),
  retireGovernanceVerificationPolicy: vi.fn(),
  revalidatePath: vi.fn(),
  actionErrorMessage: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));

vi.mock("@/lib/campus/campus-governance-service", () => ({
  createGovernanceCampus,
  updateGovernanceCampusMetadata,
  activateGovernanceCampus,
  deactivateGovernanceCampus,
}));

vi.mock("@/lib/campus/policy-governance-service", () => ({
  createGovernanceVerificationPolicyDraft,
  updateGovernanceVerificationPolicyDraft,
  publishGovernanceVerificationPolicy,
  retireGovernanceVerificationPolicy,
}));

vi.mock("@/lib/server-auth", () => ({ requireUser }));

vi.mock("@/lib/error-handler", () => ({
  actionErrorMessage: actionErrorMessage,
}));

import { governanceError } from "@/lib/governance/domain-errors";
import { rbacError } from "@/lib/rbac/errors";

import {
  activateGovernanceCampusAction,
  createGovernanceCampusAction,
  createVerificationPolicyDraftAction,
  deactivateGovernanceCampusAction,
  publishVerificationPolicyAction,
  retireVerificationPolicyAction,
  updateGovernanceCampusMetadataAction,
  updateVerificationPolicyDraftAction,
} from "@/actions/governance-campus";

/**
 * Phase 7H：校区治理 Server Action 薄适配层合同。
 *
 * 冻结链（7B/7G 同款）：validate → 身份（requireUser）→ canonical service
 * （锁内授权重读在 service 内）→ 统一映射 → revalidate。本层测试钉住：
 * - validator 拒绝路径零 service 调用（含 slug 格式 / update 至少一项）；
 * - GovernanceError 稳定机器码映射为安全 userMessage；
 * - RbacError 族 → 统一 deny 文案（授权结构不可暴露）；
 * - 未知错误 → actionErrorMessage 通道；
 * - slug 结构性不可由任何 action 修改。
 */

const ACTOR = { id: "actor-1", email: "a@x", name: "A", role: "ADMIN" as const };

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    fd.set(key, value);
  }
  return fd;
}

beforeEach(() => {
  for (const mock of [
    requireUser,
    createGovernanceCampus,
    updateGovernanceCampusMetadata,
    activateGovernanceCampus,
    deactivateGovernanceCampus,
    createGovernanceVerificationPolicyDraft,
    updateGovernanceVerificationPolicyDraft,
    publishGovernanceVerificationPolicy,
    retireGovernanceVerificationPolicy,
    revalidatePath,
    actionErrorMessage,
  ]) {
    mock.mockReset();
  }
  requireUser.mockResolvedValue(ACTOR);
  actionErrorMessage.mockReturnValue("操作失败，请稍后再试");
});

describe("createGovernanceCampusAction", () => {
  const valid = {
    name: "主校区",
    slug: "main-campus",
    schoolName: "示例大学",
    district: "海淀区",
  };

  it("成功：调 canonical service（含 trim 后字段）→ revalidate 两个路径 → 成功 message", async () => {
    createGovernanceCampus.mockResolvedValue({ id: "c1", name: "主校区", isActive: true });

    const state = await createGovernanceCampusAction(
      { success: false },
      formData(valid),
    );

    expect(state).toEqual({ success: true, message: "校区已创建：主校区" });
    expect(createGovernanceCampus).toHaveBeenCalledWith({
      actorId: ACTOR.id,
      name: "主校区",
      slug: "main-campus",
      schoolName: "示例大学",
      district: "海淀区",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/governance/campuses");
    expect(revalidatePath).toHaveBeenCalledWith("/governance/campuses/c1");
  });

  it("slug 非法 → validator 首条 issue 文案，零 service 调用", async () => {
    const state = await createGovernanceCampusAction(
      { success: false },
      formData({ ...valid, slug: "Main-Campus" }),
    );

    expect(state.success).toBe(false);
    expect(state.error).toContain("小写字母");
    expect(createGovernanceCampus).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("district 留空（optional 缺省）→ 透传 undefined", async () => {
    createGovernanceCampus.mockResolvedValue({ id: "c1", name: "主校区" });

    await createGovernanceCampusAction(
      { success: false },
      formData({ name: "主校区", slug: "main-campus", schoolName: "示例大学" }),
    );

    expect(createGovernanceCampus).toHaveBeenCalledWith(
      expect.objectContaining({ district: undefined }),
    );
  });

  it("DISTRICT-01：create 空串 → 归一化 null 透传 service（SUCCESS）", async () => {
    createGovernanceCampus.mockResolvedValue({ id: "c1", name: "主校区" });

    const state = await createGovernanceCampusAction(
      { success: false },
      formData({ name: "主校区", slug: "main-campus", schoolName: "示例大学", district: "" }),
    );

    expect(state.success).toBe(true);
    expect(createGovernanceCampus).toHaveBeenCalledWith(
      expect.objectContaining({ district: null }),
    );
  });

  it("DISTRICT-04：纯空白 → 归一化 null", async () => {
    createGovernanceCampus.mockResolvedValue({ id: "c1", name: "主校区" });

    await createGovernanceCampusAction(
      { success: false },
      formData({ name: "主校区", slug: "main-campus", schoolName: "示例大学", district: "   " }),
    );

    expect(createGovernanceCampus).toHaveBeenCalledWith(
      expect.objectContaining({ district: null }),
    );
  });

  it("CAMPUS_SLUG_CONFLICT（GovernanceError）→ 稳定 userMessage", async () => {
    createGovernanceCampus.mockRejectedValue(governanceError("CAMPUS_SLUG_CONFLICT"));

    const state = await createGovernanceCampusAction({ success: false }, formData(valid));

    expect(state).toEqual({ success: false, error: "该校区标识符已被使用" });
  });

  it("RbacError 族 → 统一 deny 文案（授权结构不可暴露）", async () => {
    createGovernanceCampus.mockRejectedValue(rbacError("AUTH_PERMISSION_DENIED"));

    const state = await createGovernanceCampusAction({ success: false }, formData(valid));

    expect(state).toEqual({ success: false, error: "没有权限执行该校区管理操作" });
  });

  it("未知错误 → actionErrorMessage 通道", async () => {
    const boom = new Error("db down");
    createGovernanceCampus.mockRejectedValue(boom);

    const state = await createGovernanceCampusAction({ success: false }, formData(valid));

    expect(state).toEqual({ success: false, error: "操作失败，请稍后再试" });
    expect(actionErrorMessage).toHaveBeenCalledWith(boom, "createGovernanceCampusAction");
  });
});

describe("updateGovernanceCampusMetadataAction", () => {
  it("成功：更新 name → revalidate 列表与详情", async () => {
    updateGovernanceCampusMetadata.mockResolvedValue({ id: "c1", name: "新名" });

    const state = await updateGovernanceCampusMetadataAction(
      { success: false },
      formData({ campusId: "c1", name: "新名" }),
    );

    expect(state).toEqual({ success: true, message: "校区信息已更新" });
    expect(updateGovernanceCampusMetadata).toHaveBeenCalledWith({
      actorId: ACTOR.id,
      campusId: "c1",
      name: "新名",
      schoolName: undefined,
      district: undefined,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/governance/campuses/c1");
  });

  it("update service 抛 GovernanceError（campus 不存在）→ 稳定文案", async () => {
    updateGovernanceCampusMetadata.mockRejectedValue(governanceError("CAMPUS_NOT_FOUND"));

    const state = await updateGovernanceCampusMetadataAction(
      { success: false },
      formData({ campusId: "ghost", name: "X" }),
    );

    expect(state).toEqual({ success: false, error: "校区不存在" });
  });

  it("DISTRICT-02：null-district 校区仅改 name（表单 district 提交空串）→ district:null 透传", async () => {
    updateGovernanceCampusMetadata.mockResolvedValue({ id: "c1" });

    const state = await updateGovernanceCampusMetadataAction(
      { success: false },
      formData({ campusId: "c1", name: "新名", district: "" }),
    );

    expect(state.success).toBe(true);
    expect(updateGovernanceCampusMetadata).toHaveBeenCalledWith({
      actorId: ACTOR.id,
      campusId: "c1",
      name: "新名",
      schoolName: undefined,
      district: null,
    });
  });

  it("DISTRICT-03：清空既有 district（空串）→ null 透传（显式清空）", async () => {
    updateGovernanceCampusMetadata.mockResolvedValue({ id: "c1" });

    const state = await updateGovernanceCampusMetadataAction(
      { success: false },
      formData({ campusId: "c1", district: "" }),
    );

    expect(state.success).toBe(true);
    expect(updateGovernanceCampusMetadata).toHaveBeenCalledWith({
      actorId: ACTOR.id,
      campusId: "c1",
      name: undefined,
      schoolName: undefined,
      district: null,
    });
  });

  it("零字段（refine 拒绝）→ 首条 issue 文案，零 service 调用", async () => {
    const state = await updateGovernanceCampusMetadataAction(
      { success: false },
      formData({ campusId: "c1" }),
    );

    expect(state.success).toBe(false);
    expect(updateGovernanceCampusMetadata).not.toHaveBeenCalled();
  });
});

describe("activate / deactivateGovernanceCampusAction", () => {
  it("启用成功 → 「校区已启用」", async () => {
    activateGovernanceCampus.mockResolvedValue({ id: "c1", isActive: true });

    const state = await activateGovernanceCampusAction(
      { success: false },
      formData({ campusId: "c1" }),
    );

    expect(state.success).toBe(true);
    expect(state.message).toBe("校区已启用");
    expect(activateGovernanceCampus).toHaveBeenCalledWith({ actorId: ACTOR.id, campusId: "c1" });
  });

  it("停用成功 → 语义文案明示不级联义务", async () => {
    deactivateGovernanceCampus.mockResolvedValue({ id: "c1", isActive: false });

    const state = await deactivateGovernanceCampusAction(
      { success: false },
      formData({ campusId: "c1" }),
    );

    expect(state.success).toBe(true);
    expect(state.message).toContain("不影响既有成员与在途义务");
    expect(deactivateGovernanceCampus).toHaveBeenCalledWith({ actorId: ACTOR.id, campusId: "c1" });
  });

  it("campusId 缺失 → uniform deny，零 service 调用", async () => {
    const state = await deactivateGovernanceCampusAction({ success: false }, formData({}));

    expect(state).toEqual({ success: false, error: "没有权限执行该校区管理操作" });
    expect(deactivateGovernanceCampus).not.toHaveBeenCalled();
  });

  it("toggle service 抛 RbacError → 统一 deny 文案", async () => {
    activateGovernanceCampus.mockRejectedValue(rbacError("AUTH_CAMPUS_SCOPE_MISMATCH"));

    const state = await activateGovernanceCampusAction(
      { success: false },
      formData({ campusId: "c1" }),
    );

    expect(state).toEqual({ success: false, error: "没有权限执行该校区管理操作" });
  });
});

describe("policy governance actions", () => {
  it("createVerificationPolicyDraftAction 成功 → 版本号回显", async () => {
    createGovernanceVerificationPolicyDraft.mockResolvedValue({ id: "p1", version: 3 });

    const state = await createVerificationPolicyDraftAction(
      { success: false },
      formData({ campusId: "c1", title: "规则", instructions: "说明" }),
    );

    expect(state).toEqual({ success: true, message: "认证策略草稿 v3 已创建" });
    expect(createGovernanceVerificationPolicyDraft).toHaveBeenCalledWith({
      actorId: ACTOR.id,
      campusId: "c1",
      title: "规则",
      instructions: "说明",
      effectiveAt: undefined,
    });
  });

  it("createVerificationPolicyDraftAction instructions 为空 → validator 拒绝", async () => {
    const state = await createVerificationPolicyDraftAction(
      { success: false },
      formData({ campusId: "c1", title: "规则", instructions: "  " }),
    );

    expect(state.success).toBe(false);
    expect(createGovernanceVerificationPolicyDraft).not.toHaveBeenCalled();
  });

  it("create draft service 抛 GovernanceError → 稳定文案", async () => {
    createGovernanceVerificationPolicyDraft.mockRejectedValue(governanceError("CAMPUS_NOT_FOUND"));

    const state = await createVerificationPolicyDraftAction(
      { success: false },
      formData({ campusId: "ghost", title: "规则", instructions: "说明" }),
    );

    expect(state).toEqual({ success: false, error: "校区不存在" });
  });

  it("updateVerificationPolicyDraftAction 成功（含 effectiveAt 解析）", async () => {
    updateGovernanceVerificationPolicyDraft.mockResolvedValue({ id: "p1", version: 3 });

    const state = await updateVerificationPolicyDraftAction(
      { success: false },
      formData({ campusId: "c1", policyId: "p1", title: "新标题" }),
    );

    expect(state).toEqual({ success: true, message: "草稿已更新" });
    expect(updateGovernanceVerificationPolicyDraft).toHaveBeenCalledWith({
      actorId: ACTOR.id,
      policyId: "p1",
      title: "新标题",
      instructions: undefined,
      effectiveAt: undefined,
    });
  });

  it("updateVerificationPolicyDraftAction IMMUTABLE（GovernanceError）→ 稳定文案", async () => {
    updateGovernanceVerificationPolicyDraft.mockRejectedValue(
      governanceError("CAMPUS_VERIFICATION_POLICY_IMMUTABLE"),
    );

    const state = await updateVerificationPolicyDraftAction(
      { success: false },
      formData({ campusId: "c1", policyId: "p1", title: "新标题" }),
    );

    expect(state).toEqual({
      success: false,
      error: "该认证策略已发布或退役，内容不可修改",
    });
  });

  it("publishVerificationPolicyAction 成功 → 版本号回显", async () => {
    publishGovernanceVerificationPolicy.mockResolvedValue({ id: "p1", version: 2 });

    const state = await publishVerificationPolicyAction(
      { success: false },
      formData({ campusId: "c1", policyId: "p1" }),
    );

    expect(state).toEqual({ success: true, message: "认证策略 v2 已发布" });
    expect(publishGovernanceVerificationPolicy).toHaveBeenCalledWith({
      actorId: ACTOR.id,
      policyId: "p1",
    });
  });

  it("retireVerificationPolicyAction 成功", async () => {
    retireGovernanceVerificationPolicy.mockResolvedValue({ id: "p1", status: "RETIRED" });

    const state = await retireVerificationPolicyAction(
      { success: false },
      formData({ campusId: "c1", policyId: "p1" }),
    );

    expect(state).toEqual({ success: true, message: "认证策略已退役" });
    expect(retireGovernanceVerificationPolicy).toHaveBeenCalledWith({
      actorId: ACTOR.id,
      policyId: "p1",
    });
  });

  it("policyId 缺失 → uniform deny（不泄露授权结构）", async () => {
    const state = await publishVerificationPolicyAction(
      { success: false },
      formData({ campusId: "c1" }),
    );

    expect(state).toEqual({ success: false, error: "没有权限执行该校区管理操作" });
    expect(publishGovernanceVerificationPolicy).not.toHaveBeenCalled();
  });

  it("publish service 抛错（GovernanceError）→ 稳定文案", async () => {
    publishGovernanceVerificationPolicy.mockRejectedValue(
      governanceError("CAMPUS_VERIFICATION_POLICY_ALREADY_PUBLISHED"),
    );

    const state = await publishVerificationPolicyAction(
      { success: false },
      formData({ campusId: "c1", policyId: "p1" }),
    );

    expect(state).toEqual({
      success: false,
      error: "该认证策略已发布，内容不可修改",
    });
  });

  it("retire service 抛 RbacError → 统一 deny 文案", async () => {
    retireGovernanceVerificationPolicy.mockRejectedValue(rbacError("AUTH_PERMISSION_DENIED"));

    const state = await retireVerificationPolicyAction(
      { success: false },
      formData({ campusId: "c1", policyId: "p1" }),
    );

    expect(state).toEqual({ success: false, error: "没有权限执行该校区管理操作" });
  });

  it("TIME-04：编辑未改时间（hidden 携带原绝对 ISO）→ service 收到同一绝对 instant", async () => {
    updateGovernanceVerificationPolicyDraft.mockResolvedValue({ id: "p1", version: 3 });

    await updateVerificationPolicyDraftAction(
      { success: false },
      formData({
        campusId: "c1",
        policyId: "p1",
        title: "新标题",
        effectiveAt: "2026-10-01T00:00:00.000Z",
      }),
    );

    expect(updateGovernanceVerificationPolicyDraft).toHaveBeenCalledWith({
      actorId: ACTOR.id,
      policyId: "p1",
      title: "新标题",
      instructions: undefined,
      // Date 相等断言：同一绝对 instant，零 timezone drift
      effectiveAt: new Date("2026-10-01T00:00:00.000Z"),
    });
  });

  it("TIME 编辑清空时间 → effectiveAt 缺省透传（row 原值不被触碰）", async () => {
    updateGovernanceVerificationPolicyDraft.mockResolvedValue({ id: "p1", version: 3 });

    await updateVerificationPolicyDraftAction(
      { success: false },
      formData({ campusId: "c1", policyId: "p1", title: "新标题", effectiveAt: "" }),
    );

    expect(updateGovernanceVerificationPolicyDraft).toHaveBeenCalledWith({
      actorId: ACTOR.id,
      policyId: "p1",
      title: "新标题",
      instructions: undefined,
      effectiveAt: undefined,
    });
  });

  it("TIME-01 action 层：timezone-less 输入 → validator fail closed 零 service 调用", async () => {
    const state = await updateVerificationPolicyDraftAction(
      { success: false },
      formData({ campusId: "c1", policyId: "p1", effectiveAt: "2026-10-01T09:00" }),
    );

    expect(state.success).toBe(false);
    expect(updateGovernanceVerificationPolicyDraft).not.toHaveBeenCalled();
  });

  it("update schema 拒绝（policyId 缺失）→ uniform deny 零 service 调用", async () => {
    // update schema 带字段级文案（与 create 同款），parse 失败回传首条 issue
    // （zod v4 对缺失字段的首条 issue 文案随版本变化，不钉具体字符串）
    const state = await updateVerificationPolicyDraftAction(
      { success: false },
      formData({ campusId: "c1", title: "新标题" }),
    );

    expect(state.success).toBe(false);
    expect(state.error).toBeTruthy();
    expect(updateGovernanceVerificationPolicyDraft).not.toHaveBeenCalled();
  });

  it("retire schema 拒绝（campusId 缺失）→ uniform deny 零 service 调用", async () => {
    const state = await retireVerificationPolicyAction(
      { success: false },
      formData({ policyId: "p1" }),
    );

    expect(state).toEqual({ success: false, error: "没有权限执行该校区管理操作" });
    expect(retireGovernanceVerificationPolicy).not.toHaveBeenCalled();
  });
});
