"use server";

import { redirect } from "next/navigation";
import { decimalValue } from "@/lib/decimal";
import { actionErrorMessage } from "@/lib/error-handler";
import { deleteErrandTx, transitionErrandTx, updateErrandContentTx } from "@/lib/errand-lifecycle";
import { containsBannedKeyword } from "@/lib/moderation";
import { prepareActiveAccountMutation } from "@/lib/governance/active-account-mutation";
import { enforceMarketplaceCapability } from "@/lib/enforcement/capability-gate";
import { claimErrandTx } from "@/lib/order-creation";
import { prisma, withTransaction } from "@/lib/prisma";
import { revalidateErrandViews } from "@/lib/revalidate";
import { requireUser } from "@/lib/server-auth";
import { createNotifications } from "@/repositories/notification-repository";
import { errandFormSchema, errandStatusSchema } from "@/validators/errand";

export type ErrandActionState = {
  success: boolean;
  message: string;
  redirectTo?: string;
};

const initialState: ErrandActionState = {
  success: false,
  message: "",
};

function parseDeadline(input: string) {
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function createErrand(
  _prevState: ErrandActionState,
  formData: FormData,
): Promise<ErrandActionState> {
  try {
    const user = await requireUser();

    const parsed = errandFormSchema.safeParse({
      title: formData.get("title"),
      description: formData.get("description"),
      categoryId: formData.get("categoryId"),
      reward: formData.get("reward"),
      pickupLocation: formData.get("pickupLocation"),
      deliveryLocation: formData.get("deliveryLocation"),
      deadline: formData.get("deadline"),
      contactNote: formData.get("contactNote"),
      needsAdvancePay: formData.get("needsAdvancePay"),
      advanceAmount: formData.get("advanceAmount"),
    });

    if (!parsed.success) {
      return {
        ...initialState,
        message: parsed.error.issues[0]?.message ?? "任务信息不完整",
      };
    }

    const deadline = parseDeadline(parsed.data.deadline);
    if (!deadline || deadline <= new Date()) {
      return { ...initialState, message: "截止时间必须晚于当前时间" };
    }

    const bannedKeyword = await containsBannedKeyword(
      `${parsed.data.title}\n${parsed.data.description}\n${parsed.data.contactNote}`,
    );

    if (bannedKeyword) {
      return {
        ...initialState,
        message: `内容命中违规关键词：${bannedKeyword}`,
      };
    }

    const [publisher, category] = await Promise.all([
      prisma.user.findUnique({
        where: { id: user.id },
        select: { campusId: true },
      }),
      prisma.errandCategory.findUnique({
        where: { id: parsed.data.categoryId },
        select: { id: true, isActive: true },
      }),
    ]);

    if (!publisher) {
      return { ...initialState, message: "用户不存在" };
    }

    if (!category || !category.isActive) {
      return { ...initialState, message: "任务分类不存在或已停用" };
    }

    // Phase 6B/6C-3：subject 治理锁 + marketplace 能力门（account/membership/risk）
    // 与任务创建同事务——membership 停用 vs 任务发布严格先后线性化
    const errand = await withTransaction(async (tx) => {
      // RB-03：USER 锁 + 锁内 fresh active 复核（能力门之前）
      await prepareActiveAccountMutation(tx, user.id);

      await enforceMarketplaceCapability(tx, user.id, publisher.campusId);

      return tx.errandTask.create({
        data: {
          title: parsed.data.title,
          description: parsed.data.description,
          categoryId: parsed.data.categoryId,
          reward: decimalValue(parsed.data.reward),
          pickupLocation: parsed.data.pickupLocation,
          deliveryLocation: parsed.data.deliveryLocation,
          deadline,
          contactNote: parsed.data.contactNote || null,
          needsAdvancePay: parsed.data.needsAdvancePay === "true",
          advanceAmount:
            parsed.data.advanceAmount && parsed.data.advanceAmount !== ""
              ? decimalValue(parsed.data.advanceAmount)
              : null,
          campusId: publisher.campusId,
          publisherId: user.id,
        },
      });
    });

    revalidateErrandViews(errand.id);

    return {
      success: true,
      message: "任务发布成功",
      redirectTo: `/errands/${errand.id}`,
    };
  } catch (error) {
    return { ...initialState, message: actionErrorMessage(error, "createErrand") };
  }
}

export async function updateErrand(
  _prevState: ErrandActionState,
  formData: FormData,
): Promise<ErrandActionState> {
  try {
    const user = await requireUser();
    const errandId = String(formData.get("errandId") ?? "");

    const parsed = errandFormSchema.safeParse({
      title: formData.get("title"),
      description: formData.get("description"),
      categoryId: formData.get("categoryId"),
      reward: formData.get("reward"),
      pickupLocation: formData.get("pickupLocation"),
      deliveryLocation: formData.get("deliveryLocation"),
      deadline: formData.get("deadline"),
      contactNote: formData.get("contactNote"),
      needsAdvancePay: formData.get("needsAdvancePay"),
      advanceAmount: formData.get("advanceAmount"),
    });

    if (!errandId) {
      return { ...initialState, message: "任务不存在" };
    }

    if (!parsed.success) {
      return {
        ...initialState,
        message: parsed.error.issues[0]?.message ?? "任务信息不完整",
      };
    }

    const deadline = parseDeadline(parsed.data.deadline);
    if (!deadline || deadline <= new Date()) {
      return { ...initialState, message: "截止时间必须晚于当前时间" };
    }

    const errand = await prisma.errandTask.findFirst({
      where: {
        id: errandId,
        publisherId: user.id,
        deletedAt: null,
      },
      select: { id: true, status: true, campusId: true },
    });

    // 事务外 pre-read 只能 discovery（提前 UX 反馈）；最终写权威在
    // updateErrandContentTx 的锁内 fresh 复核（AUDIT2-RB02 §32/§34）
    if (!errand) {
      return { ...initialState, message: "无权修改该任务" };
    }

    if (errand.status !== "OPEN") {
      return { ...initialState, message: "只有待接单任务允许编辑" };
    }

    const category = await prisma.errandCategory.findUnique({
      where: { id: parsed.data.categoryId },
      select: { id: true, isActive: true },
    });

    if (!category || !category.isActive) {
      return { ...initialState, message: "任务分类不存在或已停用" };
    }

    const bannedKeyword = await containsBannedKeyword(
      `${parsed.data.title}\n${parsed.data.description}\n${parsed.data.contactNote}`,
    );

    if (bannedKeyword) {
      return {
        ...initialState,
        message: `内容命中违规关键词：${bannedKeyword}`,
      };
    }

    // AUDIT2-RB02：编辑写权威 = USER:publisher 锁 → ErrandTask FOR UPDATE →
    // fresh OPEN 谓词（publisher/deletedAt/status/accepterId）→ capability →
    // 内容写入。事务外 OPEN snapshot 不再能授权写入。
    const outcome = await withTransaction(async (tx) =>
      updateErrandContentTx(tx, user.id, errandId, {
        title: parsed.data.title,
        description: parsed.data.description,
        categoryId: parsed.data.categoryId,
        reward: decimalValue(parsed.data.reward),
        pickupLocation: parsed.data.pickupLocation,
        deliveryLocation: parsed.data.deliveryLocation,
        deadline,
        contactNote: parsed.data.contactNote || null,
        needsAdvancePay: parsed.data.needsAdvancePay === "true",
        advanceAmount:
          parsed.data.advanceAmount && parsed.data.advanceAmount !== ""
            ? decimalValue(parsed.data.advanceAmount)
            : null,
      }),
    );

    if (outcome === "MISSING") {
      return { ...initialState, message: "无权修改该任务" };
    }

    if (outcome === "NOT_OPEN") {
      return { ...initialState, message: "只有待接单任务允许编辑" };
    }

    revalidateErrandViews(errandId);

    return {
      success: true,
      message: "任务已更新",
      redirectTo: `/errands/${errandId}`,
    };
  } catch (error) {
    return { ...initialState, message: actionErrorMessage(error, "updateErrand") };
  }
}

export async function claimErrand(formData: FormData) {
  try {
    const user = await requireUser();
    const errandId = String(formData.get("errandId") ?? "");

    if (!errandId) {
      return;
    }

    const errand = await prisma.errandTask.findFirst({
      where: {
        id: errandId,
        deletedAt: null,
      },
      select: {
        id: true,
        publisherId: true,
        accepterId: true,
        status: true,
        reward: true,
        campusId: true,
      },
    });

    if (!errand || errand.status !== "OPEN" || errand.accepterId) {
      return;
    }

    if (errand.publisherId === user.id) {
      return;
    }

    // Phase 7C FR-02 同类收敛：tx null（moderation/状态失效/参与方失配/
    // 抢占失败）→ 静默 no-op（无成功反馈）；revalidate 无条件执行——
    // 列表刷新非成功信号，仅呈现任务已不可接的现势状态。
    await withTransaction(async (tx) =>
      claimErrandTx(tx, {
        errandId,
        publisherId: errand.publisherId,
        claimerId: user.id,
        campusId: errand.campusId,
        reward: errand.reward,
      }),
    );

    revalidateErrandViews(errandId);
  } catch (error) {
    actionErrorMessage(error, "claimErrand");
  }
}

export async function updateErrandStatus(formData: FormData) {
  try {
    // entry auth = 身份发现；RB-03 REVIEW FIX：errand snapshot /
    // isPublisher / isAccepter / canTransition 全部以 USER 锁内 fresh
    // row 重算（updateErrandStatusTx），事务外读取仅作 zod 输入无关的
    // discovery——此处完全不读 errand
    const user = await requireUser();

    const parsed = errandStatusSchema.safeParse({
      errandId: formData.get("errandId"),
      status: formData.get("status"),
    });

    if (!parsed.success) {
      return;
    }

    await withTransaction(async (tx) => {
      await transitionErrandTx(tx, user.id, parsed.data.errandId, parsed.data.status);
    });

    revalidateErrandViews(parsed.data.errandId);
  } catch (error) {
    actionErrorMessage(error, "updateErrandStatus");
  }
}

export async function deleteErrand(formData: FormData) {
  const user = await requireUser();
  const errandId = String(formData.get("errandId") ?? "");

  if (!errandId) {
    redirect("/my/errands");
  }

  // AUDIT2-RB02：删除写权威 = USER 锁 → ErrandTask FOR UPDATE → fresh
  // ownership/deletedAt/status → active-order invariant → 软删除。事务外
  // pre-read 与裸 update 的旧竞态窗口关闭；MISSING / NOT_DELETABLE /
  // ANOMALOUS_ACTIVE_ORDER 与既有"静默回列表"安全语义同形。
  try {
    const outcome = await withTransaction(async (tx) =>
      deleteErrandTx(tx, user.id, errandId),
    );

    if (outcome === "DELETED") {
      revalidateErrandViews(errandId);
    }
  } catch (error) {
    actionErrorMessage(error, "deleteErrand");
  }

  redirect("/my/errands");
}
