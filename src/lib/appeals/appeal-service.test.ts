import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  withTransactionMock,
  txEnforcementActionFindUnique,
  txUserFindUnique,
  txAppealFindUnique,
  txAppealCreate,
  txAppealUpdate,
  txQueryRaw,
  acquireGovernanceSubjectLock,
  createNotification,
  loggerWarn,
} = vi.hoisted(() => ({
  withTransactionMock: vi.fn(),
  txEnforcementActionFindUnique: vi.fn(),
  txUserFindUnique: vi.fn(),
  txAppealFindUnique: vi.fn(),
  txAppealCreate: vi.fn(),
  txAppealUpdate: vi.fn(),
  txQueryRaw: vi.fn(),
  acquireGovernanceSubjectLock: vi.fn(),
  createNotification: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {},
  withTransaction: withTransactionMock,
}));

vi.mock("@/lib/governance/governance-lock", () => ({
  acquireGovernanceSubjectLock,
}));

vi.mock("@/repositories/notification-repository", () => ({
  createNotification,
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: loggerWarn, info: vi.fn(), error: vi.fn() },
}));

import {
  APPEAL_STATEMENT_MAX_LENGTH,
  submitAppeal,
  withdrawAppeal,
} from "@/lib/appeals/appeal-service";
import { Prisma } from "@prisma/client";

const EA_ID = "ea-1";
const TARGET_ID = "target-1";

const txStub = {
  enforcementAction: { findUnique: txEnforcementActionFindUnique },
  user: { findUnique: txUserFindUnique },
  appeal: { findUnique: txAppealFindUnique, create: txAppealCreate, update: txAppealUpdate },
  $queryRaw: txQueryRaw,
};

beforeEach(() => {
  for (const fn of [
    withTransactionMock,
    txEnforcementActionFindUnique,
    txUserFindUnique,
    txAppealFindUnique,
    txAppealCreate,
    txAppealUpdate,
    txQueryRaw,
    acquireGovernanceSubjectLock,
    createNotification,
    loggerWarn,
  ]) {
    fn.mockReset();
  }
  txQueryRaw.mockResolvedValue([{ id: "ap-1" }]);
  txAppealCreate.mockResolvedValue({
    id: "ap-new",
    enforcementActionId: EA_ID,
    status: "SUBMITTED",
    createdAt: new Date(),
  });
  txAppealUpdate.mockResolvedValue({
    id: "ap-1",
    enforcementActionId: EA_ID,
    status: "WITHDRAWN",
  });
  createNotification.mockResolvedValue({});
  withTransactionMock.mockImplementation(
    async (cb: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
      cb(txStub as unknown as Prisma.TransactionClient),
  );
});

describe("submitAppeal（USER target 锁先于最终资格读；唯一约束为权威）", () => {
  it("合法提交：governance 锁先于锁内重读，statement 已 trim，通知 best-effort", async () => {
    const order: string[] = [];
    txEnforcementActionFindUnique
      .mockResolvedValueOnce({ targetId: TARGET_ID })
      .mockImplementationOnce(async () => {
        order.push("re-read-after-lock");
        return { id: EA_ID, type: "ACCOUNT_SUSPEND", targetId: TARGET_ID };
      });
    txUserFindUnique.mockResolvedValue({ deletedAt: null, erasedAt: null });
    acquireGovernanceSubjectLock.mockImplementation(async () => {
      order.push("user-lock");
    });

    const { appeal } = await submitAppeal({
      callerUserId: TARGET_ID,
      enforcementActionId: EA_ID,
      statement: "  请复核这条处罚  ",
    });

    expect(appeal.status).toBe("SUBMITTED");
    // 锁必须先于锁内重读（pre-read 仅解析锁键，绝不作为资格依据）
    expect(order).toEqual(["user-lock", "re-read-after-lock"]);
    expect(txAppealCreate).toHaveBeenCalledWith({
      data: { enforcementActionId: EA_ID, status: "SUBMITTED", statement: "请复核这条处罚" },
    });
    expect(createNotification).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: TARGET_ID,
      type: "SYSTEM",
    }));
  });

  it("statement trim 后为空或超过 2000 字 → APPEAL_NOT_ALLOWED（不进入事务写路径）", async () => {
    await expect(submitAppeal({
      callerUserId: TARGET_ID,
      enforcementActionId: EA_ID,
      statement: "   ",
    })).rejects.toMatchObject({ code: "APPEAL_NOT_ALLOWED" });

    await expect(submitAppeal({
      callerUserId: TARGET_ID,
      enforcementActionId: EA_ID,
      statement: "a".repeat(APPEAL_STATEMENT_MAX_LENGTH + 1),
    })).rejects.toMatchObject({ code: "APPEAL_NOT_ALLOWED" });
    expect(txAppealCreate).not.toHaveBeenCalled();
  });

  it("他人 EA → APPEAL_NOT_OWNED（404 防枚举）；restorative → APPEAL_NOT_ALLOWED", async () => {
    txEnforcementActionFindUnique
      .mockResolvedValueOnce({ targetId: TARGET_ID })
      .mockResolvedValue({ id: EA_ID, type: "ACCOUNT_SUSPEND", targetId: TARGET_ID });
    txUserFindUnique.mockResolvedValue({ deletedAt: null, erasedAt: null });

    await expect(submitAppeal({
      callerUserId: "someone-else",
      enforcementActionId: EA_ID,
      statement: "ok",
    })).rejects.toMatchObject({ code: "APPEAL_NOT_OWNED", status: 404 });

    txEnforcementActionFindUnique
      .mockResolvedValueOnce({ targetId: TARGET_ID })
      .mockResolvedValue({ id: EA_ID, type: "MARKETPLACE_RESTORE", targetId: TARGET_ID });
    await expect(submitAppeal({
      callerUserId: TARGET_ID,
      enforcementActionId: EA_ID,
      statement: "ok",
    })).rejects.toMatchObject({ code: "APPEAL_NOT_ALLOWED" });
  });

  it("target erased/deleted → APPEAL_NOT_ALLOWED（不产生申诉行）", async () => {
    txEnforcementActionFindUnique
      .mockResolvedValueOnce({ targetId: TARGET_ID })
      .mockResolvedValue({ id: EA_ID, type: "ACCOUNT_SUSPEND", targetId: TARGET_ID });
    txUserFindUnique.mockResolvedValue({ deletedAt: null, erasedAt: new Date() });

    await expect(submitAppeal({
      callerUserId: TARGET_ID,
      enforcementActionId: EA_ID,
      statement: "ok",
    })).rejects.toMatchObject({ code: "APPEAL_NOT_ALLOWED" });
    expect(txAppealCreate).not.toHaveBeenCalled();
  });

  it("P2002 命中 enforcementActionId 唯一约束 → 精确收敛 APPEAL_ALREADY_EXISTS", async () => {
    txEnforcementActionFindUnique
      .mockResolvedValueOnce({ targetId: TARGET_ID })
      .mockResolvedValue({ id: EA_ID, type: "ACCOUNT_SUSPEND", targetId: TARGET_ID });
    txUserFindUnique.mockResolvedValue({ deletedAt: null, erasedAt: null });
    const dupError = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed on the fields: (`enforcementActionId`)",
      { code: "P2002", clientVersion: "6.19.3", meta: { target: ["Appeal_enforcementActionId_key"] } },
    );
    txAppealCreate.mockRejectedValue(dupError);

    await expect(submitAppeal({
      callerUserId: TARGET_ID,
      enforcementActionId: EA_ID,
      statement: "ok",
    })).rejects.toMatchObject({ code: "APPEAL_ALREADY_EXISTS" });
  });

  it("非唯一约束的 P2002 不吞错（rethrow）", async () => {
    txEnforcementActionFindUnique
      .mockResolvedValueOnce({ targetId: TARGET_ID })
      .mockResolvedValue({ id: EA_ID, type: "ACCOUNT_SUSPEND", targetId: TARGET_ID });
    txUserFindUnique.mockResolvedValue({ deletedAt: null, erasedAt: null });
    txAppealCreate.mockRejectedValue(Object.assign(new Error("other unique"), {
      code: "P2002",
      meta: { target: ["someOther_key"] },
    }));

    await expect(submitAppeal({
      callerUserId: TARGET_ID,
      enforcementActionId: EA_ID,
      statement: "ok",
    })).rejects.not.toMatchObject({ code: "APPEAL_ALREADY_EXISTS" });
  });

  it("通知失败仅记 APPEAL_NOTIFICATION_FAILED，不影响 command success", async () => {
    txEnforcementActionFindUnique
      .mockResolvedValueOnce({ targetId: TARGET_ID })
      .mockResolvedValue({ id: EA_ID, type: "ACCOUNT_SUSPEND", targetId: TARGET_ID });
    txUserFindUnique.mockResolvedValue({ deletedAt: null, erasedAt: null });
    createNotification.mockRejectedValue(new Error("notification-down"));

    const { appeal } = await submitAppeal({
      callerUserId: TARGET_ID,
      enforcementActionId: EA_ID,
      statement: "ok",
    });
    expect(appeal.id).toBe("ap-new");
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("通知投递失败"),
      "appeals",
      expect.objectContaining({ event: "APPEAL_NOTIFICATION_FAILED" }),
    );
  });
});

describe("withdrawAppeal（行锁 → USER target 锁；post-erasure 禁止）", () => {
  it("SUBMITTED → WITHDRAWN：terminal decision 字段全部清空", async () => {
    txAppealFindUnique.mockResolvedValue({
      id: "ap-1",
      status: "SUBMITTED",
      enforcementActionId: EA_ID,
    });
    txEnforcementActionFindUnique.mockResolvedValue({ targetId: TARGET_ID });
    txUserFindUnique.mockResolvedValue({ deletedAt: null, erasedAt: null });

    const { appeal } = await withdrawAppeal({ callerUserId: TARGET_ID, appealId: "ap-1" });

    expect(appeal.status).toBe("WITHDRAWN");
    expect(txAppealUpdate).toHaveBeenCalledWith({
      where: { id: "ap-1" },
      data: {
        status: "WITHDRAWN",
        reviewedById: null,
        reviewedAt: null,
        decisionReasonCode: null,
        decisionNote: null,
      },
    });
  });

  it("锁序硬合同：Appeal 行锁（FOR UPDATE）先于 USER governance lock", async () => {
    const order: string[] = [];
    txQueryRaw.mockImplementation(async () => {
      order.push("appeal-row-lock");
      return [{ id: "ap-1" }];
    });
    acquireGovernanceSubjectLock.mockImplementation(async () => {
      order.push("user-target-lock");
    });
    txAppealFindUnique.mockResolvedValue({
      id: "ap-1",
      status: "SUBMITTED",
      enforcementActionId: EA_ID,
    });
    txEnforcementActionFindUnique.mockResolvedValue({ targetId: TARGET_ID });
    txUserFindUnique.mockResolvedValue({ deletedAt: null, erasedAt: null });

    await withdrawAppeal({ callerUserId: TARGET_ID, appealId: "ap-1" });
    expect(order).toEqual(["appeal-row-lock", "user-target-lock"]);
  });

  it("post-erasure withdraw → APPEAL_NOT_ALLOWED（零 user-originated mutation）", async () => {
    txAppealFindUnique.mockResolvedValue({
      id: "ap-1",
      status: "SUBMITTED",
      enforcementActionId: EA_ID,
    });
    txEnforcementActionFindUnique.mockResolvedValue({ targetId: TARGET_ID });
    txUserFindUnique.mockResolvedValue({ deletedAt: null, erasedAt: new Date() });

    await expect(withdrawAppeal({ callerUserId: TARGET_ID, appealId: "ap-1" })).rejects.toMatchObject({
      code: "APPEAL_NOT_ALLOWED",
    });
    expect(txAppealUpdate).not.toHaveBeenCalled();
  });

  it("非本人撤回 → APPEAL_NOT_OWNED（404 防枚举）", async () => {
    txAppealFindUnique.mockResolvedValue({
      id: "ap-1",
      status: "SUBMITTED",
      enforcementActionId: EA_ID,
    });
    txEnforcementActionFindUnique.mockResolvedValue({ targetId: TARGET_ID });
    txUserFindUnique.mockResolvedValue({ deletedAt: null, erasedAt: null });

    await expect(withdrawAppeal({ callerUserId: "other-user", appealId: "ap-1" })).rejects.toMatchObject({
      code: "APPEAL_NOT_OWNED",
      status: 404,
    });
  });

  it("IN_REVIEW / terminal → APPEAL_INVALID_TRANSITION", async () => {
    txAppealFindUnique.mockResolvedValue({
      id: "ap-1",
      status: "IN_REVIEW",
      enforcementActionId: EA_ID,
    });
    txEnforcementActionFindUnique.mockResolvedValue({ targetId: TARGET_ID });
    txUserFindUnique.mockResolvedValue({ deletedAt: null, erasedAt: null });

    await expect(withdrawAppeal({ callerUserId: TARGET_ID, appealId: "ap-1" })).rejects.toMatchObject({
      code: "APPEAL_INVALID_TRANSITION",
    });

    txAppealFindUnique.mockResolvedValue({
      id: "ap-1",
      status: "UPHELD",
      enforcementActionId: EA_ID,
    });
    await expect(withdrawAppeal({ callerUserId: TARGET_ID, appealId: "ap-1" })).rejects.toMatchObject({
      code: "APPEAL_INVALID_TRANSITION",
    });
  });

  it("appeal 不存在 → APPEAL_NOT_FOUND", async () => {
    txAppealFindUnique.mockResolvedValue(null);
    await expect(withdrawAppeal({ callerUserId: TARGET_ID, appealId: "ghost" })).rejects.toMatchObject({
      code: "APPEAL_NOT_FOUND",
    });
  });
});
