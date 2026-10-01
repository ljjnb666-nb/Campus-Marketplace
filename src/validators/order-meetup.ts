import { z } from "zod";

import { parseMarketplaceDateTimeLocal } from "@/lib/marketplace-time";
import {
  MEETUP_LOCATION_MAX_LENGTH,
  MEETUP_LOCATION_MIN_LENGTH,
} from "@/lib/meetups/meetup-policy";

/**
 * Phase 8D-02：Meetup 用户操作面输入合同。
 *
 * 边界（冻结）：
 * - 这里只做 FormData 的参数级 UX 校验；participant / type / status /
 *   campus / 时间窗 / 地点可用性的最终裁决全部在 canonical
 *   order-meetup-service 锁内 fresh revalidate，本文件零域判断复制。
 * - 长度常量直接复用 meetup-policy（禁止第二套 2..80 常量）；客户端
 *   提交的 campusId / actorId / targetUserId 不是合法输入，schema 不设
 *   这些字段，Action 层也绝不当作 authority 读取。
 * - scheduledAt 以 datetime-local 文本接收，经 canonical marketplace
 *   timezone（RB01：parseMarketplaceDateTimeLocal）确定性解释为绝对
 *   instant——绝不使用 new Date("YYYY-MM-DDTHH:mm")（会退化为 server
 *   local timezone 语义）；「必须是未来时间」的窗口裁决属于
 *   meetup-policy + Tx service，这里只拒绝无法解释的值。
 */

const marketplaceDateTimeLocal = z
  .string()
  .trim()
  .min(1, "请选择约定时间")
  .refine((value) => parseMarketplaceDateTimeLocal(value) !== null, {
    message: "约定时间无效",
  })
  .transform((value) => parseMarketplaceDateTimeLocal(value) as Date);

export const proposeOrderMeetupSchema = z
  .object({
    orderId: z.string().trim().min(1, "订单不存在"),
    scheduledAt: marketplaceDateTimeLocal,
    locationSource: z.enum(["MEETUP_POINT", "CUSTOM"], {
      message: "请选择见面地点来源",
    }),
    meetupPointId: z.string().trim().optional(),
    locationText: z.string().trim().optional(),
  })
  .superRefine((data, ctx) => {
    // 地点来源互斥：catalog point 与 custom 覆盖禁止同时提交
    if (data.locationSource === "MEETUP_POINT") {
      if (!data.meetupPointId) {
        ctx.addIssue({
          code: "custom",
          path: ["meetupPointId"],
          message: "请选择校内推荐见面点",
        });
      }
      if (data.locationText) {
        ctx.addIssue({
          code: "custom",
          path: ["locationText"],
          message: "见面地点来源不合法",
        });
      }
    }
    if (data.locationSource === "CUSTOM") {
      if (data.meetupPointId) {
        ctx.addIssue({
          code: "custom",
          path: ["meetupPointId"],
          message: "见面地点来源不合法",
        });
      }
      const text = data.locationText ?? "";
      if (
        text.length < MEETUP_LOCATION_MIN_LENGTH ||
        text.length > MEETUP_LOCATION_MAX_LENGTH
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["locationText"],
          message: `见面地点需为 ${MEETUP_LOCATION_MIN_LENGTH}-${MEETUP_LOCATION_MAX_LENGTH} 个字`,
        });
      }
    }
  });

export const orderMeetupMutationSchema = z.object({
  orderId: z.string().trim().min(1, "订单不存在"),
  meetupId: z.string().trim().min(1, "见面约定不存在"),
});

export type ProposeOrderMeetupFormData = z.infer<typeof proposeOrderMeetupSchema>;
export type OrderMeetupMutationFormData = z.infer<typeof orderMeetupMutationSchema>;
