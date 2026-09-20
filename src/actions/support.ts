"use server";

import { revalidatePath } from "next/cache";

import { actionErrorMessage } from "@/lib/error-handler";
import { isSupportTicketError } from "@/lib/support/errors";
import { createSupportTicket } from "@/lib/support/support-service";
import { requireUser } from "@/lib/server-auth";
import { supportTicketCreateSchema } from "@/validators/support";

/**
 * Phase 7G：用户面创建支持工单的薄 Server Action（7A/7E 冻结约定）。
 *
 * 硬合同：
 * - requesterId 一律来自 requireUser()，绝不信 FormData 的任何身份字段；
 * - 仅做：validate（.strict()）→ 服务端身份 → canonical 域服务
 *   （USER:requester 锁 / active recheck / membership recheck / 3 条上限 /
 *   scope snapshot / dueAt 全在 canonical 服务内）→ revalidate；
 * - SUPPORT_ATTACHMENTS = OUT_OF_SCOPE：本 action 结构上不接收任何文件字段。
 */

export type SupportCreateActionState = {
  success: boolean;
  ticketId?: string;
  error?: string;
};

export async function createSupportTicketAction(
  formData: FormData,
): Promise<SupportCreateActionState> {
  try {
    const campusIdRaw = formData.get("campusId");
    const parsed = supportTicketCreateSchema.safeParse({
      category: formData.get("category"),
      subject: formData.get("subject"),
      description: formData.get("description"),
      campusId: typeof campusIdRaw === "string" && campusIdRaw.length > 0 ? campusIdRaw : undefined,
    });
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? "参数无效" };
    }

    const user = await requireUser();
    const ticket = await createSupportTicket({
      requesterId: user.id,
      category: parsed.data.category,
      subject: parsed.data.subject,
      description: parsed.data.description,
      campusId: parsed.data.campusId,
    });

    revalidatePath("/support");
    return { success: true, ticketId: ticket.id };
  } catch (error) {
    if (isSupportTicketError(error)) {
      return { success: false, error: error.message };
    }
    return { success: false, error: actionErrorMessage(error, "createSupportTicketAction") };
  }
}
