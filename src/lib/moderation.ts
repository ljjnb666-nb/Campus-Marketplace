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

// 关键词列表变化频率极低，用短 TTL 缓存避免每次内容提交/发消息都全量查库
const KEYWORD_CACHE_TTL_MS = 60_000;

let keywordCache: { at: number; keywords: string[] } | null = null;

export function resetModerationKeywordCache() {
  keywordCache = null;
}

async function loadEnabledKeywords() {
  if (keywordCache && Date.now() - keywordCache.at < KEYWORD_CACHE_TTL_MS) {
    return keywordCache.keywords;
  }

  const enabledKeywords = await prisma.moderationKeyword.findMany({
    where: { isEnabled: true },
    select: { keyword: true },
    orderBy: { createdAt: "asc" },
  });

  const keywords =
    enabledKeywords.length > 0 ? enabledKeywords.map((item) => item.keyword) : [...defaultBannedKeywords];
  keywordCache = { at: Date.now(), keywords };
  return keywords;
}

export async function containsBannedKeyword(input: string) {
  const source = await loadEnabledKeywords();

  return source.find((keyword) => input.includes(keyword)) ?? null;
}
