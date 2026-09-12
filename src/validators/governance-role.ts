import { z } from "zod";

/**
 * Phase 7B 角色管理面 action/pagination 合同（Planning Repair + P1 冻结）。
 *
 * - .strict()：roleKey/actorId/targetUserId/scopeKey/assignedById 等
 *   服务端所有字段一律拒绝（不做静默 strip——"ignore 不够安全"，
 *   与 6C-2 appealSubmit 同约定）；
 * - grant/lookup 不接收 roleKey：v1 服务器固定授予
 *   CAMPUS_APPEAL_REVIEWER（P1 security boundary，非 UI convenience）；
 * - email = trim + 语法校验后 exact 匹配 stored email（FR-01：注册侧不做
 *   lowercase 归一，本层不得发明 lowercase 身份键）；未命中 → action 层
 *   统一 deny（无存在性 oracle）；
 * - cursor 是 base64url(JSON) 的 UNTRUSTED 分页位置（assignedAt+id），
 *   解析失败 → null（调用方安全失败态）；scope 授权独立于 cursor，
 *   伪造 cursor 只能改变位置，永远改变不了授权范围。
 *   Phase 7B 自有 codec：不修改 Phase 7A appeal cursor（Repair 5 冻结）。
 */

export const GOVERNANCE_ROLE_DEFAULT_PAGE_SIZE = 25;
export const GOVERNANCE_ROLE_MAX_PAGE_SIZE = 50;

// FR-01（Final Review）：trim → email 语法校验 → exact stored-email lookup。
// 注册侧存库不做 lowercase 归一，7B 不得发明 lowercase 身份键——大小写
// 逐字保留后精确匹配；未命中 → action 层统一 deny（无存在性 oracle）。
// 注册/登录/schema（citext）/迁移/回填等全仓归一是独立未来工作，本层禁动。
const governanceRoleEmailSchema = z
  .string()
  .trim()
  .min(3, "请输入用户邮箱")
  .max(254, "邮箱长度不合法")
  .email("请输入正确邮箱");

export const governanceRoleLookupSchema = z
  .object({
    campusId: z.string().min(1, "请选择校区"),
    email: governanceRoleEmailSchema,
  })
  .strict();

export const governanceRoleGrantSchema = z
  .object({
    campusId: z.string().min(1, "请选择校区"),
    email: governanceRoleEmailSchema,
  })
  .strict();

export const governanceRoleRevokeSchema = z
  .object({
    assignmentId: z.string().min(1, "参数无效"),
  })
  .strict();

/** 缺席 → 默认页大小；非法（非整数 / 越界）→ 调用方安全回退默认值。 */
export const governanceRolePageLimitSchema = z.coerce
  .number()
  .int()
  .min(1, "limit 必须在 1 到 50 之间")
  .max(GOVERNANCE_ROLE_MAX_PAGE_SIZE, "limit 必须在 1 到 50 之间");

const governanceRoleCursorPayloadSchema = z
  .object({
    assignedAt: z.iso.datetime({ message: "cursor 无效" }),
    id: z.string().min(1, "cursor 无效"),
  })
  .strict();

export type GovernanceRoleCursor = { assignedAt: Date; id: string };

/** 由实际返回的最后一条 item 生成下一页 cursor（base64url(JSON)）。 */
export function encodeGovernanceRoleCursor(cursor: {
  assignedAt: Date;
  id: string;
}): string {
  return Buffer.from(
    JSON.stringify({ assignedAt: cursor.assignedAt.toISOString(), id: cursor.id }),
  ).toString("base64url");
}

/**
 * 解码客户端回传的 cursor。任何解析/校验失败（含非法时间戳/缺 id/任意
 * base64）返回 null（调用方映射安全失败态）。
 */
export function decodeGovernanceRoleCursor(raw: string): GovernanceRoleCursor | null {
  let payload: unknown;
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    payload = JSON.parse(json);
  } catch {
    return null;
  }

  const parsed = governanceRoleCursorPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }

  const assignedAt = new Date(parsed.data.assignedAt);
  if (Number.isNaN(assignedAt.getTime())) {
    return null;
  }

  return { assignedAt, id: parsed.data.id };
}
