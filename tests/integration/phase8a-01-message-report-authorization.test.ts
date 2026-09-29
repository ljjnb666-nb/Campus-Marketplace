import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Phase 8A-01（P8-B02）MESSAGE report 资源级授权 集成测试（真实 PostgreSQL）。
//
// 关闭的缺口：知道任意 messageId 的 authenticated user 此前可举报他人私有
// 会话消息（resolver 只验证 Message 存在）。修复后授权合同：
//
//   MESSAGE_REPORT_ALLOWED IFF
//     reporter active-account mutation contract 通过
//     AND Message 存在
//     AND reporter ∈ ConversationParticipant(Message.conversationId)
//     AND reporter != Message.senderId
//
// 覆盖（指令冻结矩阵）：
//  - MSG-AUTH-01：participant 举报 counterpart 的 DIRECT message → 全链成立
//    （Report / 1:1 ModerationCase / REPORT_SUBMITTED 投影 / reporter 通知）
//  - MSG-AUTH-02：非 participant 持 exact messageId → DENY + ZERO durable side effect
//  - MSG-AUTH-03：其它会话的合法 participant → DENY（授权 = exact conversation
//    pair，不是"任意会话成员"）
//  - MSG-AUTH-04：sender 自举报 → DENY（既有 self-report 保护锁定）
//  - MSG-AUTH-05：message 不存在 → DENY，且与 foreign 情况用户可见失败同类
//    （no resource existence oracle）
//  - MSG-AUTH-06：合法 MESSAGE report 恒 campusId=null / scopeKey=UNSCOPED
//    （Phase 7E 冻结合同，不从会话双方 campus 推导）
//  - 附加：duplicate open report 保护、SYSTEM message（senderId=null）被
//    participant 举报维持现状、§15 message content 不外泄
//
// 真实入口：requireUser session seam + 完整 createReport server action
// （授权判定发生在 action 事务内部，而非 helper 直调）。

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

const sessionSeam = vi.hoisted(() => ({
  actionUser: { current: null as null | { id: string; email: string; name: string } },
}));

vi.mock("@/lib/server-auth", () => ({
  requireUser: async () => {
    if (!sessionSeam.actionUser.current) {
      throw new Error("NO_SESSION");
    }
    return sessionSeam.actionUser.current;
  },
  requireAdmin: async () => {
    if (!sessionSeam.actionUser.current) {
      throw new Error("NO_SESSION");
    }
    return sessionSeam.actionUser.current;
  },
}));

const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

const rawClient = integrationDatabaseUrl
  ? new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL ?? integrationDatabaseUrl } },
      log: ["error"],
    })
  : null;

const RUN_TAG = `p8a01-${randomUUID().slice(0, 8)}`;
const FIXTURE_PASSWORD_HASH = ["$2a$10$", "itfixtureitfixtureitfixtureitfixtureitfix"].join("");
const MESSAGE_CONTENT_SENTINEL = `${RUN_TAG}-私有消息内容-8A01E2EShouldNotLeak`;

const createdUserIds: string[] = [];
const createdCampusIds: string[] = [];
const createdMembershipIds: string[] = [];
const createdConversationIds: string[] = [];
const createdReportIds: string[] = [];

let campusA: { id: string };
// 会话 1：A、B 双方；会话 2：C、D 双方
let userA: { id: string };
let userB: { id: string };
let userC: { id: string };
let userD: { id: string };
// 会话 1 中的消息
let counterpartMessage: { id: string; conversationId: string }; // sender = B（A 举报 B 的合法目标）
let selfMessage: { id: string; conversationId: string }; // sender = A（self-report 目标）
let systemMessage: { id: string; conversationId: string }; // senderId = null（SYSTEM 语义现状锁定）
// 会话 2 中的消息（证明 C 是真实 participant，但属于另一会话）
let otherConversationMessage: { id: string; conversationId: string };

async function createFixtureUser(name: string) {
  const user = await rawClient!.user.create({
    data: {
      email: `${RUN_TAG}-${createdUserIds.length}-${name}@it.local`,
      name,
      passwordHash: FIXTURE_PASSWORD_HASH,
      schoolName: "集成测试大学",
      campusId: campusA.id,
      role: "STUDENT",
      status: "ACTIVE",
    },
  });
  createdUserIds.push(user.id);
  const membership = await rawClient!.campusMembership.create({
    data: { userId: user.id, campusId: campusA.id, status: "ACTIVE" },
  });
  createdMembershipIds.push(membership.id);
  return user;
}

async function createConversationFixture(
  participantIds: [string, string],
  messages: { senderId: string | null; type?: "DIRECT" | "SYSTEM" | "ORDER" }[],
) {
  const conversation = await rawClient!.conversation.create({
    data: {
      participants: {
        create: participantIds.map((userId) => ({ userId })),
      },
    },
  });
  createdConversationIds.push(conversation.id);
  const createdMessages: { id: string; conversationId: string }[] = [];
  for (const message of messages) {
    const created = await rawClient!.message.create({
      data: {
        conversationId: conversation.id,
        senderId: message.senderId,
        type: message.type ?? "DIRECT",
        content: MESSAGE_CONTENT_SENTINEL,
      },
    });
    createdMessages.push({ id: created.id, conversationId: created.conversationId });
  }
  return { conversation, messages: createdMessages };
}

/**
 * ZERO DURABLE SIDE EFFECT 断言：拒绝路径不得产生任何 report/case/flag/notification。
 *
 * ModerationCase（reportId FK）与 RiskFlag（sourceId=reportId）都以 Report 行
 * 为唯一锚点——"该 reporter 未产生新 report + 该 message 的 report 总数不变 +
 * reporter 无新增 REPORT 通知"即结构性排除一切 case/flag/通知副作用。
 */
async function expectZeroDurableSideEffects(input: {
  reporterId: string;
  messageId: string;
  /** 该 message 上拒绝前既有的合法 report 总数（不得增减） */
  expectedExistingReports: number;
  /** reporter 拒绝前既有的 REPORT 通知数（拒绝不得新增） */
  expectedExistingNotifications?: number;
}) {
  expect(
    await rawClient!.report.count({
      where: { messageId: input.messageId, reporterId: input.reporterId },
    }),
  ).toBe(0);

  const reportIdsForMessage = (
    await rawClient!.report.findMany({
      where: { messageId: input.messageId },
      select: { id: true },
    })
  ).map((row) => row.id);
  expect(reportIdsForMessage).toHaveLength(input.expectedExistingReports);
  expect(
    await rawClient!.moderationCase.count({ where: { reportId: { in: reportIdsForMessage } } }),
  ).toBe(reportIdsForMessage.length);

  expect(
    await rawClient!.notification.count({
      where: { userId: input.reporterId, type: "REPORT" },
    }),
  ).toBe(input.expectedExistingNotifications ?? 0);
}

function messageReportForm(messageId: string, detail: string) {
  const formData = new FormData();
  formData.set("targetType", "MESSAGE");
  formData.set("reason", "HARASSMENT");
  formData.set("detail", detail);
  formData.set("productId", "");
  formData.set("errandTaskId", "");
  formData.set("serviceListingId", "");
  formData.set("rentalListingId", "");
  formData.set("targetUserId", "");
  formData.set("messageId", messageId);
  return formData;
}

beforeAll(async () => {
  if (!rawClient) return;

  campusA = await rawClient.campus.create({
    data: { name: `${RUN_TAG}-校区`, slug: `${RUN_TAG}-campus`, schoolName: "集成测试大学", isActive: true },
  });
  createdCampusIds.push(campusA.id);

  userA = await createFixtureUser("举报者A");
  userB = await createFixtureUser("发送者B");
  userC = await createFixtureUser("外来者C");
  userD = await createFixtureUser("会话二D");

  const conversation1 = await createConversationFixture([userA.id, userB.id], [
    { senderId: userB.id },
    { senderId: userA.id },
    { senderId: null, type: "SYSTEM" },
  ]);
  counterpartMessage = conversation1.messages[0];
  selfMessage = conversation1.messages[1];
  systemMessage = conversation1.messages[2];

  const conversation2 = await createConversationFixture([userC.id, userD.id], [
    { senderId: userD.id },
  ]);
  otherConversationMessage = conversation2.messages[0];
});

afterAll(async () => {
  if (!rawClient) return;

  // 反向依赖顺序清理（fixture 全部带 RUN_TAG 域，不触碰共享数据）
  await rawClient.moderationCase.deleteMany({ where: { reportId: { in: createdReportIds } } });
  await rawClient.riskFlag.deleteMany({ where: { sourceType: "REPORT", sourceId: { in: createdReportIds } } });
  await rawClient.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await rawClient.report.deleteMany({ where: { id: { in: createdReportIds } } });
  await rawClient.message.deleteMany({ where: { conversationId: { in: createdConversationIds } } });
  await rawClient.conversationParticipant.deleteMany({
    where: { conversationId: { in: createdConversationIds } },
  });
  await rawClient.conversation.deleteMany({ where: { id: { in: createdConversationIds } } });
  await rawClient.campusMembership.deleteMany({ where: { id: { in: createdMembershipIds } } });
  await rawClient.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await rawClient.campus.deleteMany({ where: { id: { in: createdCampusIds } } });
  await rawClient.$disconnect();
});

describe.skipIf(!integrationDatabaseUrl)("Phase 8A-01 MESSAGE report 资源级授权（真实 PostgreSQL）", () => {
  it("MSG-AUTH-01/06：participant 举报 counterpart 消息 → 全链成立 + UNSCOPED 冻结合同", async () => {
    const { createReport } = await import("@/actions/trust");

    sessionSeam.actionUser.current = { id: userA.id, email: "", name: "" };
    const result = await createReport(
      { success: false, message: "" },
      messageReportForm(counterpartMessage.id, "对方发送骚扰内容"),
    );

    expect(result.success).toBe(true);

    const report = await rawClient!.report.findFirstOrThrow({
      where: { messageId: counterpartMessage.id, reporterId: userA.id },
    });
    createdReportIds.push(report.id);

    expect(report.targetType).toBe("MESSAGE");
    expect(report.messageId).toBe(counterpartMessage.id);
    expect(report.reporterId).toBe(userA.id);
    // MSG-AUTH-06：MESSAGE 恒 UNSCOPED（不从会话双方 campus 推导）
    expect(report.campusId).toBeNull();
    expect(report.scopeKey).toBe("UNSCOPED");

    // 1:1 ModerationCase（SLA 起点 = report.createdAt）
    const kase = await rawClient!.moderationCase.findUniqueOrThrow({ where: { reportId: report.id } });
    expect(kase.campusId).toBeNull();
    expect(kase.scopeKey).toBe("UNSCOPED");
    expect(kase.closedAt).toBeNull();
    expect(kase.openedAt.getTime()).toBe(report.createdAt.getTime());
    expect(kase.dueAt.getTime() - kase.openedAt.getTime()).toBe(48 * 60 * 60 * 1000);

    // Phase 6B 投影合同：REPORT_SUBMITTED ACTIVE on sender（B），campus 对齐 null
    const submittedFlag = await rawClient!.riskFlag.findUniqueOrThrow({
      where: {
        kind_sourceType_sourceId: {
          kind: "REPORT_SUBMITTED",
          sourceType: "REPORT",
          sourceId: report.id,
        },
      },
    });
    expect(submittedFlag.userId).toBe(userB.id);
    expect(submittedFlag.status).toBe("ACTIVE");
    expect(submittedFlag.campusId).toBeNull();

    // §15 隐私边界：message content 不得进入任何 durable 通知/日志面
    const notifications = await rawClient!.notification.findMany({
      where: { userId: userA.id, type: "REPORT" },
    });
    expect(notifications.length).toBe(1);
    expect(JSON.stringify(notifications)).not.toContain(MESSAGE_CONTENT_SENTINEL);

    // §20 duplicate open report 保护：同 reporter 同目标再次提交 → 拒绝
    const duplicateResult = await createReport(
      { success: false, message: "" },
      messageReportForm(counterpartMessage.id, "重复提交"),
    );
    expect(duplicateResult).toEqual({
      success: false,
      message: "该目标已有待处理举报，请勿重复提交",
    });
    expect(
      await rawClient!.report.count({ where: { messageId: counterpartMessage.id, reporterId: userA.id } }),
    ).toBe(1);
  });

  it("MSG-AUTH-02：非 participant 持 exact messageId → DENY + 零 durable side effect", async () => {
    const { createReport } = await import("@/actions/trust");

    sessionSeam.actionUser.current = { id: userC.id, email: "", name: "" };
    const result = await createReport(
      { success: false, message: "" },
      messageReportForm(counterpartMessage.id, "外来者越权举报他人私信"),
    );

    expect(result.success).toBe(false);
    await expectZeroDurableSideEffects({
      reporterId: userC.id,
      messageId: counterpartMessage.id,
      expectedExistingReports: 1,
    });

    // A 的合法 report 及其投影不受扰动；会话消息未被扰动
    expect(
      await rawClient!.report.count({ where: { messageId: counterpartMessage.id } }),
    ).toBe(1);
    expect(await rawClient!.message.count({ where: { conversationId: counterpartMessage.conversationId } })).toBe(3);
  });

  it("MSG-AUTH-03：其它会话的合法 participant → DENY（exact conversation pair 授权）", async () => {
    const { createReport } = await import("@/actions/trust");

    // C 确为会话 2 的真实 participant（排除"根本不是任何会话成员"的平凡拒绝）
    const cParticipant = await rawClient!.conversationParticipant.findUniqueOrThrow({
      where: {
        conversationId_userId: { conversationId: otherConversationMessage.conversationId, userId: userC.id },
      },
    });
    expect(cParticipant).toBeDefined();

    sessionSeam.actionUser.current = { id: userC.id, email: "", name: "" };
    const result = await createReport(
      { success: false, message: "" },
      messageReportForm(counterpartMessage.id, "跨会话 participant 越权举报"),
    );

    expect(result.success).toBe(false);
    await expectZeroDurableSideEffects({
      reporterId: userC.id,
      messageId: counterpartMessage.id,
      expectedExistingReports: 1,
    });
    expect(
      await rawClient!.report.count({ where: { messageId: counterpartMessage.id } }),
    ).toBe(1);
  });

  it("MSG-AUTH-04：participant 举报自己的消息 → DENY（既有 self-report 保护）", async () => {
    const { createReport } = await import("@/actions/trust");

    sessionSeam.actionUser.current = { id: userA.id, email: "", name: "" };
    const result = await createReport(
      { success: false, message: "" },
      messageReportForm(selfMessage.id, "自举报自己发送的消息"),
    );

    expect(result).toEqual({ success: false, message: "不能举报自己发布或发送的内容" });
    expect(await rawClient!.report.count({ where: { messageId: selfMessage.id } })).toBe(0);
    await expectZeroDurableSideEffects({
      reporterId: userA.id,
      messageId: selfMessage.id,
      expectedExistingReports: 0,
      // A 在 MSG-AUTH-01 的合法举报通知：拒绝不得新增
      expectedExistingNotifications: 1,
    });
  });

  it("MSG-AUTH-05：message 不存在 → DENY，且与 foreign 情况同类失败（no oracle）", async () => {
    const { createReport } = await import("@/actions/trust");

    sessionSeam.actionUser.current = { id: userA.id, email: "", name: "" };
    const missingResult = await createReport(
      { success: false, message: "" },
      messageReportForm(`ghost-${randomUUID()}`, "目标不存在"),
    );
    expect(missingResult).toEqual({ success: false, message: "举报目标不存在" });

    sessionSeam.actionUser.current = { id: userC.id, email: "", name: "" };
    const foreignResult = await createReport(
      { success: false, message: "" },
      messageReportForm(counterpartMessage.id, "越权举报"),
    );
    expect(foreignResult).toEqual({ success: false, message: "举报目标不存在" });

    // 用户可见结果完全同类 → 不构成"消息存在但无权"的资源存在 oracle
    expect(missingResult.message).toBe(foreignResult.message);

    // ZERO SIDE EFFECT：ghost messageId 未产生任何 report；A 名下 MESSAGE report
    // 仍只有 MSG-AUTH-01 的合法一条
    expect(
      await rawClient!.report.count({ where: { targetType: "MESSAGE", reporterId: userA.id } }),
    ).toBe(1);
    expect(
      await rawClient!.notification.count({ where: { userId: userA.id, type: "REPORT" } }),
    ).toBe(1);
  });

  it("8A-01 附加：SYSTEM message（senderId=null）被 participant 举报 → 维持现状允许", async () => {
    const { createReport } = await import("@/actions/trust");

    // 不发明新 SYSTEM-message 政策：现有行为允许 participant 举报系统消息，
    // 本测试锁定该现状（ownerUserId=null → reconcile 投影为 no-op）
    sessionSeam.actionUser.current = { id: userA.id, email: "", name: "" };
    const result = await createReport(
      { success: false, message: "" },
      messageReportForm(systemMessage.id, "系统消息异常"),
    );

    expect(result.success).toBe(true);
    const report = await rawClient!.report.findFirstOrThrow({
      where: { messageId: systemMessage.id, reporterId: userA.id },
    });
    createdReportIds.push(report.id);

    expect(report.campusId).toBeNull();
    expect(report.scopeKey).toBe("UNSCOPED");
    // 匿名 sender：REPORT_SUBMITTED/REPORT_CONFIRMED 投影 no-op（既有合同）
    expect(
      await rawClient!.riskFlag.count({ where: { sourceType: "REPORT", sourceId: report.id } }),
    ).toBe(0);
  });
});
