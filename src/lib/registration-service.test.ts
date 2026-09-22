import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  withTransactionMock,
  acquireGovernanceSubjectLocks,
  campusFindFirst,
  userCreate,
  createActiveMembership,
  recordSignupAcceptances,
} = vi.hoisted(() => ({
  withTransactionMock: vi.fn(),
  acquireGovernanceSubjectLocks: vi.fn(),
  campusFindFirst: vi.fn(),
  userCreate: vi.fn(),
  createActiveMembership: vi.fn(),
  recordSignupAcceptances: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
  withTransaction: withTransactionMock,
}));

vi.mock("@/lib/governance/governance-lock", () => ({
  acquireGovernanceSubjectLocks,
}));

vi.mock("@/lib/campus/membership-service", () => ({
  createActiveMembership,
}));

vi.mock("@/lib/legal/policy-service", () => ({
  recordSignupAcceptances,
}));

import type { Prisma } from "@prisma/client";
import { registerActiveCampusUser } from "@/lib/registration-service";

/**
 * FR01：注册事务权威（registration transaction authority）单测。
 * 锁定 recheck / 写入序列 / 零部分注册的失败语义在此钉住；
 * 与 deactivation 的双方向线性化由真 PostgreSQL C-RACE-06 承担。
 */

const txStub = {
  campus: { findFirst: campusFindFirst },
  user: { create: userCreate },
} as unknown as Prisma.TransactionClient;

const BASE_INPUT = {
  name: "张同学",
  email: "student1@campus.local",
  passwordHash: "hashed-password",
  schoolName: "示例大学",
  campusId: "campus-1",
  acceptedDocumentIds: ["doc-terms-1", "doc-privacy-1"],
};

beforeEach(() => {
  for (const mock of [
    withTransactionMock,
    acquireGovernanceSubjectLocks,
    campusFindFirst,
    userCreate,
    createActiveMembership,
    recordSignupAcceptances,
  ]) {
    mock.mockReset();
  }
  withTransactionMock.mockImplementation(
    async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => callback(txStub),
  );
  acquireGovernanceSubjectLocks.mockResolvedValue(undefined);
  campusFindFirst.mockResolvedValue({ id: "campus-1" });
  userCreate.mockResolvedValue({ id: "user-1", email: BASE_INPUT.email });
  createActiveMembership.mockResolvedValue({ id: "membership-1" });
  recordSignupAcceptances.mockResolvedValue({ created: 2, skipped: 0 });
});

describe("registerActiveCampusUser（FR01 registration transaction authority）", () => {
  it("注册事务先取 CAMPUS:<campusId> governance subject 锁（与 deactivate 同 helper 同 namespace）", async () => {
    await registerActiveCampusUser(BASE_INPUT);

    expect(acquireGovernanceSubjectLocks).toHaveBeenCalledWith(txStub, [
      { subjectType: "CAMPUS", subjectId: "campus-1" },
    ]);
  });

  it("锁内 locked re-read 强制 isActive: true（admission 判定与写入同持锁窗口）", async () => {
    await registerActiveCampusUser(BASE_INPUT);

    expect(campusFindFirst).toHaveBeenCalledWith({
      where: { id: "campus-1", isActive: true },
      select: { id: true },
    });
    // re-read 先于任何写入
    expect(campusFindFirst.mock.invocationCallOrder[0]).toBeLessThan(
      userCreate.mock.invocationCallOrder[0]!,
    );
  });

  it("成功路径：User.create（passwordHash 由调用方事务外计算）→ ACTIVE membership → acceptances 同事务", async () => {
    const result = await registerActiveCampusUser(BASE_INPUT);

    expect(result).toMatchObject({ ok: true, user: { id: "user-1" } });
    expect(userCreate).toHaveBeenCalledWith({
      data: {
        name: "张同学",
        email: "student1@campus.local",
        passwordHash: "hashed-password",
        schoolName: "示例大学",
        campusId: "campus-1",
      },
    });
    expect(createActiveMembership).toHaveBeenCalledWith(txStub, {
      userId: "user-1",
      campusId: "campus-1",
    });
    expect(recordSignupAcceptances).toHaveBeenCalledWith(
      txStub,
      "user-1",
      BASE_INPUT.acceptedDocumentIds,
    );
  });

  it("校区不可用（已停用/不存在）→ ok:false 单一 reason；ZERO 写入（零部分注册）", async () => {
    campusFindFirst.mockResolvedValue(null);

    const result = await registerActiveCampusUser(BASE_INPUT);

    expect(result).toEqual({ ok: false, reason: "CAMPUS_NOT_AVAILABLE" });
    expect(userCreate).not.toHaveBeenCalled();
    expect(createActiveMembership).not.toHaveBeenCalled();
    expect(recordSignupAcceptances).not.toHaveBeenCalled();
  });

  it("acceptances 失败 → 异常上抛（事务整体回滚，不留无同意的账号）", async () => {
    recordSignupAcceptances.mockRejectedValue(new Error("LEGAL_DOCUMENT_VERSION_CHANGED"));

    await expect(registerActiveCampusUser(BASE_INPUT)).rejects.toThrow(
      "LEGAL_DOCUMENT_VERSION_CHANGED",
    );
  });

  it("P2002 邮箱唯一冲突原样上抛（由 Server Action 映射安全文案）", async () => {
    const conflict = new (class extends Error {
      code = "P2002";
    })("Unique constraint failed");
    userCreate.mockRejectedValue(conflict);

    await expect(registerActiveCampusUser(BASE_INPUT)).rejects.toBe(conflict);
  });
});
