"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { setFeatureFlag } from "@/lib/feature-flags/feature-flag-service";
import { FEATURE_FLAG_KEYS } from "@/lib/feature-flags/feature-flag-registry";
import { requireUser } from "@/lib/server-auth";

export type FeatureFlagActionState = {
  status: "idle" | "success" | "error" | "conflict";
  message: string;
};

const inputSchema = z.object({
  key: z.enum(FEATURE_FLAG_KEYS),
  campusId: z.string().max(128),
  expectedVersion: z.coerce.number().int().min(0).safe(),
  nextValue: z.enum(["true", "false", "inherit"]),
  acknowledgement: z.literal("已确认影响范围"),
}).strict();

/**
 * Thin server action. No actorId, permissions or transaction semantics sourced
 * from the browser; the 10F writer alone owns locked fresh auth/CAS/audit.
 */
export async function changeGovernanceFeatureFlag(
  _previous: FeatureFlagActionState,
  formData: FormData,
): Promise<FeatureFlagActionState> {
  const entries = [...formData.entries()];
  if (entries.some(([key, value]) => typeof value !== "string") ||
      new Set(entries.map(([key]) => key)).size !== entries.length) {
    return { status: "error", message: "提交参数无效，请刷新页面重试" };
  }
  const parsed = inputSchema.safeParse(Object.fromEntries(entries));
  if (!parsed.success) {
    return { status: "error", message: "提交参数无效，请刷新页面重试" };
  }
  if (parsed.data.nextValue === "inherit" && parsed.data.expectedVersion === 0) {
    return { status: "error", message: "当前没有可恢复的校区覆盖配置" };
  }

  try {
    const user = await requireUser();
    const result = await setFeatureFlag({
      actorId: user.id,
      key: parsed.data.key,
      campusId: parsed.data.campusId || null,
      disabled: parsed.data.nextValue === "inherit"
        ? null : parsed.data.nextValue === "true",
      expectedVersion: parsed.data.expectedVersion,
    });
    revalidatePath("/governance/feature-flags");
    return { status: "success", message: `配置已保存（版本 ${result.version}），审计记录已生成` };
  } catch (error) {
    if (error instanceof Error && error.message === "FEATURE_FLAG_VERSION_CONFLICT") {
      return { status: "conflict", message: "配置已被其他管理员修改，请刷新后核对最新状态" };
    }
    if (error instanceof Error && error.message === "FEATURE_FLAG_OVERRIDE_NOT_FOUND") {
      return { status: "conflict", message: "覆盖配置已不存在，请刷新后重试" };
    }
    // Do not leak actor RBAC, DB errors or internal error details.
    return { status: "error", message: "操作未完成，请检查权限或稍后重试" };
  }
}
