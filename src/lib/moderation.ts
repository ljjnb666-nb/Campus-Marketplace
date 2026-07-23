import { prisma } from "@/lib/prisma";

const defaultBannedKeywords = [
  "代写作业",
  "代考",
  "论文代写",
  "考试作弊",
  "违禁品",
  "账号买卖",
  "虚假兼职",
  "违法金融",
] as const;

export async function containsBannedKeyword(input: string) {
  const enabledKeywords = await prisma.moderationKeyword.findMany({
    where: { isEnabled: true },
    select: { keyword: true },
    orderBy: { createdAt: "asc" },
  });

  const source = enabledKeywords.length > 0 ? enabledKeywords.map((item) => item.keyword) : defaultBannedKeywords;

  return source.find((keyword) => input.includes(keyword)) ?? null;
}
