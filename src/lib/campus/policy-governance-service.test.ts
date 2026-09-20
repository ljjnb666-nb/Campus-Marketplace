import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  withTransactionMock,
  acquireGovernanceSubjectLocks,
  acquireCampusVerificationPolicyLocks,
  loadAuthorizationContext,
  requirePermissionInContext,
  recordAdminAudit,
  publishVerificationPolicyInTx,
  retireVerificationPolicyInTx,
  policyAggregate,
  policyCreate,
  policyFindUnique,
  policyUpdate,
} = vi.hoisted(() => ({
  withTransactionMock: vi.fn(),
  acquireGovernanceSubjectLocks: vi.fn(),
  acquireCampusVerificationPolicyLocks: vi.fn(),
  loadAuthorizationContext: vi.fn(),
  requirePermissionInContext: vi.fn(),
  recordAdminAudit: vi.fn(),
  publishVerificationPolicyInTx: vi.fn(),
  retireVerificationPolicyInTx: vi.fn(),
  policyAggregate: vi.fn(),
  policyCreate: vi.fn(),
  policyFindUnique: vi.fn(),
  policyUpdate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
  withTransaction: withTransactionMock,
}));

vi.mock("@/lib/governance/governance-lock", () => ({
  acquireGovernanceSubjectLocks,
  acquireCampusVerificationPolicyLocks,
}));

vi.mock("@/lib/rbac/service", () => ({
  loadAuthorizationContext,
  requirePermissionInContext,
}));

vi.mock("@/lib/governance/admin-audit", () => ({ recordAdminAudit }));

// computePolicyContentHash 保持真实实现（canonical hash 语义同源），
// 仅 mock 既有 publish/retire 的 InTx 变体（§31：零第二套 state machine）
vi.mock("@/lib/campus/verification-policy-service", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/campus/verification-policy-service")
  >();
  return {
    ...actual,
    publishVerificationPolicyInTx,
    retireVerificationPolicyInTx,
  };
});

import { computePolicyContentHash } from "@/lib/campus/verification-policy-service";
import {
  createGovernanceVerificationPolicyDraft,
  publishGovernanceVerificationPolicy,
  retireGovernanceVerificationPolicy,
  updateGovernanceVerificationPolicyDraft,
} from "@/lib/campus/policy-governance-service";

import type { Prisma } from "@prisma/client";

const txStub = {
  campus: { findUnique: vi.fn() },
  campusVerificationPolicy: {
    aggregate: policyAggregate,
    create: policyCreate,
    findUnique: policyFindUnique,
    update: policyUpdate,
  },
} as unknown as Prisma.TransactionClient;

const ACTOR = "actor-1";
const CAMPUS_ID = "campus-a";
const AUTH_CONTEXT = { userId: ACTOR, accountActive: true, activeCampusIds: [], grants: [] };

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "policy-1",
    campusId: CAMPUS_ID,
    version: 3,
    status: "DRAFT",
    title: "认证规则",
    instructions: "上传学生证",
    contentHash: computePolicyContentHash("上传学生证"),
    effectiveAt: new Date("2026-01-01T00:00:00Z"),
    publishedAt: null,
    createdById: ACTOR,
    ...overrides,
  };
}

beforeEach(() => {
  for (const mock of [
    withTransactionMock,
    acquireGovernanceSubjectLocks,
    acquireCampusVerificationPolicyLocks,
    loadAuthorizationContext,
    requirePermissionInContext,
    recordAdminAudit,
    publishVerificationPolicyInTx,
    retireVerificationPolicyInTx,
    policyAggregate,
    policyCreate,
    policyFindUnique,
    policyUpdate,
  ]) {
    mock.mockReset();
  }
  withTransactionMock.mockImplementation(
    async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => callback(txStub),
  );
  acquireGovernanceSubjectLocks.mockResolvedValue(undefined);
  acquireCampusVerificationPolicyLocks.mockResolvedValue(undefined);
  loadAuthorizationContext.mockResolvedValue(AUTH_CONTEXT);
  requirePermissionInContext.mockResolvedValue(undefined);
  recordAdminAudit.mockResolvedValue(undefined);
  (txStub.campus.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: CAMPUS_ID });
  policyAggregate.mockResolvedValue({ _max: { version: 2 } });
  policyCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => draftRow(data));
  policyFindUnique.mockResolvedValue(draftRow());
  policyUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    draftRow(data),
  );
});

describe("createGovernanceVerificationPolicyDraft（CP01/§33）", () => {
  it("锁内 max(version)+1 顺序分配；客户端不能指定 version；hash 服务器现算 + audit", async () => {
    const draft = await createGovernanceVerificationPolicyDraft({
      actorId: ACTOR,
      campusId: CAMPUS_ID,
      title: " 认证规则 ",
      instructions: "上传学生证",
    });

    expect(acquireGovernanceSubjectLocks).toHaveBeenCalledWith(txStub, [
      { subjectType: "USER", subjectId: ACTOR },
    ]);
    expect(acquireCampusVerificationPolicyLocks).toHaveBeenCalledWith(txStub, [CAMPUS_ID]);
    expect(loadAuthorizationContext).toHaveBeenCalledWith(ACTOR, txStub);
    expect(requirePermissionInContext).toHaveBeenCalledWith(AUTH_CONTEXT, "campus.manage");

    expect(policyAggregate).toHaveBeenCalledWith({
      _max: { version: true },
      where: { campusId: CAMPUS_ID },
    });
    expect(policyCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        campusId: CAMPUS_ID,
        version: 3,
        status: "DRAFT",
        title: "认证规则",
        contentHash: computePolicyContentHash("上传学生证"),
        createdById: ACTOR,
      }),
    });
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CREATE_VERIFICATION_POLICY_DRAFT",
        campusId: CAMPUS_ID,
        metadata: { policyVersion: 3 },
      }),
      txStub,
    );
    expect(draft.version).toBe(3);
  });

  it("max 为空（首版）→ version 1", async () => {
    policyAggregate.mockResolvedValue({ _max: { version: null } });

    await createGovernanceVerificationPolicyDraft({
      actorId: ACTOR,
      campusId: CAMPUS_ID,
      title: "认证规则",
      instructions: "上传学生证",
    });

    expect(policyCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ version: 1 }),
    });
  });

  it("campus 不存在 → CAMPUS_NOT_FOUND", async () => {
    (txStub.campus.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(
      createGovernanceVerificationPolicyDraft({
        actorId: ACTOR,
        campusId: "ghost",
        title: "认证规则",
        instructions: "上传学生证",
      }),
    ).rejects.toMatchObject({ code: "CAMPUS_NOT_FOUND" });
    expect(policyCreate).not.toHaveBeenCalled();
  });

  it("CP08 派生层：授权重读失败 → fail closed 零 mutation", async () => {
    requirePermissionInContext.mockRejectedValue(new Error("AUTH_PERMISSION_DENIED"));

    await expect(
      createGovernanceVerificationPolicyDraft({
        actorId: ACTOR,
        campusId: CAMPUS_ID,
        title: "认证规则",
        instructions: "上传学生证",
      }),
    ).rejects.toThrow("AUTH_PERMISSION_DENIED");
    expect(policyCreate).not.toHaveBeenCalled();
    expect(recordAdminAudit).not.toHaveBeenCalled();
  });
});

describe("updateGovernanceVerificationPolicyDraft（CP02/CP03/CP04/§34）", () => {
  it("CP02：instructions 修改重算 contentHash；title/effectiveAt 可改；version 不变", async () => {
    await updateGovernanceVerificationPolicyDraft({
      actorId: ACTOR,
      policyId: "policy-1",
      title: "新标题",
      instructions: "新说明",
      effectiveAt: new Date("2026-02-01T00:00:00Z"),
    });

    expect(policyUpdate).toHaveBeenCalledWith({
      where: { id: "policy-1" },
      data: {
        title: "新标题",
        instructions: "新说明",
        contentHash: computePolicyContentHash("新说明"),
        effectiveAt: new Date("2026-02-01T00:00:00Z"),
      },
    });
    expect(recordAdminAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "UPDATE_VERIFICATION_POLICY_DRAFT",
        metadata: { policyVersion: 3 },
      }),
      txStub,
    );
  });

  it("CP03：PUBLISHED IMMUTABLE → CAMPUS_VERIFICATION_POLICY_IMMUTABLE 零 update", async () => {
    policyFindUnique.mockResolvedValue(draftRow({ status: "PUBLISHED", publishedAt: new Date() }));

    await expect(
      updateGovernanceVerificationPolicyDraft({
        actorId: ACTOR,
        policyId: "policy-1",
        instructions: "篡改",
      }),
    ).rejects.toMatchObject({ code: "CAMPUS_VERIFICATION_POLICY_IMMUTABLE" });
    expect(policyUpdate).not.toHaveBeenCalled();
  });

  it("CP04：RETIRED IMMUTABLE → CAMPUS_VERIFICATION_POLICY_IMMUTABLE 零 update", async () => {
    policyFindUnique.mockResolvedValue(draftRow({ status: "RETIRED" }));

    await expect(
      updateGovernanceVerificationPolicyDraft({
        actorId: ACTOR,
        policyId: "policy-1",
        instructions: "篡改",
      }),
    ).rejects.toMatchObject({ code: "CAMPUS_VERIFICATION_POLICY_IMMUTABLE" });
    expect(policyUpdate).not.toHaveBeenCalled();
  });

  it("policy 不存在 → CAMPUS_VERIFICATION_POLICY_NOT_FOUND", async () => {
    policyFindUnique.mockResolvedValue(null);

    await expect(
      updateGovernanceVerificationPolicyDraft({
        actorId: ACTOR,
        policyId: "ghost",
        instructions: "X",
      }),
    ).rejects.toMatchObject({ code: "CAMPUS_VERIFICATION_POLICY_NOT_FOUND" });
  });

  it("零字段 → 幂等 no-op 零 audit", async () => {
    await updateGovernanceVerificationPolicyDraft({ actorId: ACTOR, policyId: "policy-1" });

    expect(policyUpdate).not.toHaveBeenCalled();
    expect(recordAdminAudit).not.toHaveBeenCalled();
  });
});

describe("publish / retire 治理 seam（CP05/CP06/§35）", () => {
  it("publish：锁链 + 锁定授权重读后复用既有 publish invariant（InTx 变体 + actorId）", async () => {
    publishVerificationPolicyInTx.mockResolvedValue(draftRow({ status: "PUBLISHED" }));

    const published = await publishGovernanceVerificationPolicy({ actorId: ACTOR, policyId: "policy-1" });

    expect(acquireGovernanceSubjectLocks).toHaveBeenCalledWith(txStub, [
      { subjectType: "USER", subjectId: ACTOR },
    ]);
    expect(acquireCampusVerificationPolicyLocks).toHaveBeenCalledWith(txStub, [CAMPUS_ID]);
    expect(requirePermissionInContext).toHaveBeenCalledWith(AUTH_CONTEXT, "campus.manage");
    expect(publishVerificationPolicyInTx).toHaveBeenCalledWith(txStub, "policy-1", {
      actorId: ACTOR,
    });
    expect(published.status).toBe("PUBLISHED");
  });

  it("CP06：retire 已 RETIRED → 幂等原样返回（无重复 InTx 调用、无重复 audit）", async () => {
    policyFindUnique.mockResolvedValue(draftRow({ status: "RETIRED" }));

    const retired = await retireGovernanceVerificationPolicy({ actorId: ACTOR, policyId: "policy-1" });

    expect(retireVerificationPolicyInTx).not.toHaveBeenCalled();
    expect(recordAdminAudit).not.toHaveBeenCalled();
    expect(retired.status).toBe("RETIRED");
  });

  it("DRAFT → retire 复用既有 InTx 变体（既有 state truth 保持）", async () => {
    retireVerificationPolicyInTx.mockResolvedValue(draftRow({ status: "RETIRED" }));

    await retireGovernanceVerificationPolicy({ actorId: ACTOR, policyId: "policy-1" });

    expect(retireVerificationPolicyInTx).toHaveBeenCalledWith(txStub, "policy-1", {
      actorId: ACTOR,
    });
  });

  it("CP05：publish idempotent 合同由既有 invariant 承接（PUBLISHED 时 InTx 直接返回不产出第二个版本）", async () => {
    policyFindUnique.mockResolvedValue(draftRow({ status: "PUBLISHED", publishedAt: new Date() }));
    publishVerificationPolicyInTx.mockResolvedValue(
      draftRow({ status: "PUBLISHED", publishedAt: new Date() }),
    );

    await publishGovernanceVerificationPolicy({ actorId: ACTOR, policyId: "policy-1" });

    // 治理 seam 不绕过既有 invariant：幂等语义完全由 verification-policy-service 承接
    expect(publishVerificationPolicyInTx).toHaveBeenCalledTimes(1);
    expect(policyUpdate).not.toHaveBeenCalled();
  });
});

describe("CP09：audit metadata 不含 instructions/content（§36/§58 隐私合同）", () => {
  it("四个动作的 audit metadata 仅 policyVersion（campusId 走专用列）", async () => {
    await createGovernanceVerificationPolicyDraft({
      actorId: ACTOR,
      campusId: CAMPUS_ID,
      title: "认证规则",
      instructions: "上传学生证 + 身份证 + 人脸",
    });
    await updateGovernanceVerificationPolicyDraft({
      actorId: ACTOR,
      policyId: "policy-1",
      instructions: "新说明",
    });
    publishVerificationPolicyInTx.mockResolvedValue(draftRow({ status: "PUBLISHED" }));
    await publishGovernanceVerificationPolicy({ actorId: ACTOR, policyId: "policy-1" });
    retireVerificationPolicyInTx.mockResolvedValue(draftRow({ status: "RETIRED" }));
    await retireGovernanceVerificationPolicy({ actorId: ACTOR, policyId: "policy-1" });

    expect(recordAdminAudit).toHaveBeenCalledTimes(2); // publish/retire 的 audit 在既有 InTx 变体内
    for (const call of recordAdminAudit.mock.calls) {
      const input = call[0] as { metadata?: Record<string, unknown> };
      expect(Object.keys(input.metadata ?? {})).toEqual(["policyVersion"]);
      expect(JSON.stringify(input.metadata)).not.toContain("上传学生证");
      expect(JSON.stringify(input.metadata)).not.toContain("新说明");
    }
  });
});
