"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireUser } from "@/lib/server-auth";
import { setRuntimeConfig } from "@/lib/runtime-config/runtime-config-service";
import {
  parseRuntimeConfigValue, RUNTIME_CONFIG_REGISTRY,
  type RuntimeConfigKey,
} from "@/lib/runtime-config/runtime-config-registry";

export type RuntimeConfigActionState = {
  status: "idle" | "success" | "error" | "conflict";
  message: string;
};

const registeredKeys = Object.keys(RUNTIME_CONFIG_REGISTRY) as [RuntimeConfigKey, ...RuntimeConfigKey[]];
const schema = z.object({
  key: z.enum(registeredKeys),
  campusId: z.string().max(128),
  expectedVersion: z.string().regex(/^(0|[1-9][0-9]*)$/),
  nextValue: z.string().min(1).max(32),
  acknowledgement: z.literal("已确认配置影响"),
}).strict();

/** No browser-supplied actor, grant or transaction authority. */
export async function changeGovernanceRuntimeConfig(
  _previous: RuntimeConfigActionState,
  form: FormData,
): Promise<RuntimeConfigActionState> {
  const entries = [...form.entries()];
  if (entries.some(([,value]) => typeof value !== "string") ||
      new Set(entries.map(([key]) => key)).size !== entries.length) {
    return { status: "error", message: "提交参数无效，请刷新后重试" };
  }
  const parsed = schema.safeParse(Object.fromEntries(entries));
  if (!parsed.success) return { status: "error", message: "提交参数无效，请刷新后重试" };

  const { key, campusId, nextValue } = parsed.data;
  const expectedVersion = Number(parsed.data.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    return { status: "error", message: "配置版本无效，请刷新后重试" };
  }
  if (nextValue === "inherit" && expectedVersion === 0) {
    return { status: "error", message: "当前没有可恢复的覆盖配置" };
  }

  let value: number | null = null;
  if (nextValue !== "inherit") {
    if (!/^(0|[1-9][0-9]*)$/.test(nextValue)) {
      return { status: "error", message: "请输入允许范围内的整数" };
    }
    try {
      value = parseRuntimeConfigValue(key, Number(nextValue));
    } catch {
      return { status: "error", message: "配置值超出允许范围，请检查后重试" };
    }
  }

  try {
    const actor = await requireUser();
    const result = await setRuntimeConfig({
      actorId: actor.id, key, campusId: campusId || null, value, expectedVersion,
    });
    revalidatePath("/governance/runtime-config");
    return { status: "success", message: `配置已保存（版本 ${result.version}），审计记录已生成` };
  } catch (error) {
    if (error instanceof Error && error.message === "RUNTIME_CONFIG_VERSION_CONFLICT") {
      return { status: "conflict", message: "版本已被其他管理员更新，请刷新后核对" };
    }
    if (error instanceof Error && error.message === "RUNTIME_CONFIG_OVERRIDE_NOT_FOUND") {
      return { status: "conflict", message: "覆盖配置已不存在，请刷新后重试" };
    }
    return { status: "error", message: "操作未完成，请检查权限或稍后重试" };
  }
}
