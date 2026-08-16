// 稳定唯一的会话 Key 算法（纯函数，禁止放入 "use server" 文件以免被暴露为 RPC）
export type ConversationBizType =
  | "PRODUCT"
  | "ERRAND"
  | "SERVICE"
  | "RENTAL"
  | "PRODUCT_ORDER"
  | "RENTAL_ORDER";

export async function computeConversationKey(
  type: ConversationBizType,
  bizId: string,
  participantIds: string[],
): Promise<string> {
  const sortedUsers = [...participantIds].sort();
  return `${type}:${bizId}:${sortedUsers.join(":")}`;
}
