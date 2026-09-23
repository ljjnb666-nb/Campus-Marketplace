import type { Prisma } from "@prisma/client";

import { prepareActiveAccountMutation, type ActiveAccountMutationSeams } from "@/lib/governance/active-account-mutation";
import { resolveSingleImageToken } from "@/lib/upload";

/**
 * RB-03：个人资料 mutation 的领域逻辑（从 server action 中抽出）。
 *
 * ACTIVE_ACCOUNT_MUTATION_CONTRACT：USER governance 锁 + 锁内 fresh
 * active 复核（prepareActiveAccountMutation）→ fresh previous state →
 * 权威写入，全部在同一事务边界内。与 eraseAccount 同一 USER 锁域串行：
 * erase 先提交 → 本 mutation 锁内复核失败回滚（无 PII resurrection）；
 * profile 先提交 → erase 随后执行且保持最终权威。
 *
 * 头像的对象存储上传（S3 PUT，外部副作用）由调用方在事务外完成；若本
 * 事务因账号失效被拒，已上传资产停留在 UPLOADED 态，由既有 stale-upload
 * cleanup（UPLOADING TTL 恢复 + 配额回收）兜底，不产生永久孤儿。
 */
export type UpdateOwnProfileInput = {
  name: string;
  bio: string;
  college: string;
  grade: string;
  phone: string;
  /** 头像 token（asset:<id> / 历史路径 / 空）——资产绑定在本事务内完成 */
  avatarToken: string;
};

export async function updateOwnProfileTx(
  tx: Prisma.TransactionClient,
  userId: string,
  input: UpdateOwnProfileInput,
  seams?: ActiveAccountMutationSeams,
): Promise<{
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  bio: string | null;
  college: string | null;
  grade: string | null;
  phone: string | null;
  /** 事务内读到的旧头像值（供调用方事务外做旧资源清理比较） */
  previousAvatarUrl: string | null;
}> {
  await prepareActiveAccountMutation(tx, userId, seams);

  // fresh previous state（锁内）：头像替换清理的比较基准不再信任
  // 事务外 pre-read
  const previous = await tx.user.findUnique({
    where: { id: userId },
    select: { avatarUrl: true },
  });

  // 头像 token 规范化并绑定新上传资源（avatar 无独立实体，仅标记 ATTACHED）
  const avatarUrl = await resolveSingleImageToken({
    ownerId: userId,
    token: input.avatarToken,
    target: { type: "avatar" },
    tx,
  });

  const updated = await tx.user.update({
    where: { id: userId },
    data: {
      name: input.name,
      bio: input.bio || null,
      college: input.college || null,
      grade: input.grade || null,
      phone: input.phone || null,
      avatarUrl: avatarUrl || null,
    },
    select: {
      id: true,
      name: true,
      email: true,
      avatarUrl: true,
      bio: true,
      college: true,
      grade: true,
      phone: true,
    },
  });

  return { ...updated, previousAvatarUrl: previous?.avatarUrl ?? null };
}
