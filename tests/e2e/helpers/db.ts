/**
 * Playwright 侧的最终状态断言（Browser drives action, DB verifies invariant）。
 * 连接 E2E 专用数据库，与被测应用同库——这是断言，不是 mock。
 */
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/campus_e2e?schema=public";

let client: PrismaClient | undefined;

export function e2eDb(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      datasources: { db: { url: E2E_DATABASE_URL } },
    });
  }
  return client;
}

/**
 * Phase 5 fixture seam（仅 E2E 基建使用）：
 * 发布某个类型的下一个政策版本（等价于真实 publish 服务语义：
 * SHA-256 contentHash + PUBLISHED + publishedAt，effectiveAt=now）。
 */
export async function seedNextPolicyVersion(
  type: "TERMS_OF_SERVICE" | "PRIVACY_POLICY" | "PLATFORM_RULES" | "PROHIBITED_TRANSACTIONS",
  title: string,
  content: string,
): Promise<{ id: string; version: number; contentHash: string }> {
  const db = e2eDb();
  const highest = await db.legalDocument.findFirst({
    where: { type },
    orderBy: { version: "desc" },
    select: { version: true },
  });

  const version = (highest?.version ?? 0) + 1;
  const contentHash = createHash("sha256").update(content, "utf8").digest("hex");

  const document = await db.legalDocument.create({
    data: {
      type,
      version,
      status: "PUBLISHED",
      title,
      content,
      contentHash,
      effectiveAt: new Date(),
      publishedAt: new Date(),
      requiresAcceptance: true,
    },
  });

  return { id: document.id, version, contentHash };
}

/** Phase 5 fixture seam：给用户挂一个 ACTIVE 数据冻结（hold）。 */
export async function seedActiveDataHold(
  subjectId: string,
  type: "LEGAL" | "DISPUTE" = "LEGAL",
): Promise<string> {
  const hold = await e2eDb().dataHold.create({
    data: { type, subjectId, reasonCode: "E2E_FIXTURE_HOLD" },
  });

  return hold.id;
}

/** Phase 5 fixture seam：解除 hold（release）。 */
export async function releaseDataHold(holdId: string): Promise<void> {
  await e2eDb().dataHold.update({
    where: { id: holdId },
    data: { status: "RELEASED", releasedAt: new Date() },
  });
}

/**
 * Phase 5 REPAIR fixture seam：将用户标记为"已注销"（erasedAt），
 * 用于 stale-JWT 回归：登录态 cookie 保留、账号已被注销时，
 * 任何 authenticated 边界必须拒绝。仅供 E2E 基建使用。
 */
export async function eraseUserFixture(email: string): Promise<void> {
  await e2eDb().user.update({
    where: { email },
    data: { erasedAt: new Date() },
  });
}

/**
 * Phase 5 fixture seam：【TEST FIXTURE ACCEPTANCE】为指定账号直接插入
 * 对某文档的同意证据（仅在升级测试里用于把版本升级对并行 worker 中
 * 其他 storageState 账号的影响窗口压到毫秒级；不代表生产语义）。
 */
export async function seedPolicyAcceptanceFor(
  email: string,
  documentId: string,
): Promise<void> {
  const db = e2eDb();
  const user = await db.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  const document = await db.legalDocument.findUniqueOrThrow({
    where: { id: documentId },
    select: { type: true, version: true, contentHash: true },
  });

  await db.policyAcceptance.upsert({
    where: { userId_documentId: { userId: user.id, documentId } },
    update: {},
    create: {
      userId: user.id,
      documentId,
      documentType: document.type,
      documentVersion: document.version,
      documentHash: document.contentHash,
      source: "SIGNUP",
      acceptedAt: new Date(),
    },
  });
}
