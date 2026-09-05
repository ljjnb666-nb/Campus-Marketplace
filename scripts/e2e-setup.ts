/**
 * E2E deterministic bootstrap（Playwright Release Gate 前置）：
 *
 * 1. 确保 E2E 专用数据库存在（默认 campus_e2e，与开发库 campus_marketplace 隔离）
 * 2. prisma migrate deploy（真实迁移，禁止 migrate dev）
 * 3. 按外键顺序清空全部业务表 → upsert 校区 / 四类分类 / E2E 确定性账号
 * 4. 清理 Redis 限流键（ratelimit:*），避免注册/登录限流污染下一轮
 * 5. 写入 run-state（本轮开始时间），teardown 据此清理本轮 MinIO 对象
 *
 * 幂等：run #1 / run #2 / run #n 结果一致，不依赖开发者本机数据。
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient, UserRole, VerificationStatus } from "@prisma/client";
import { hashSync } from "bcryptjs";
import { Redis } from "ioredis";

import { assertE2EDatabaseIsolation, sanitizeDatabaseUrl } from "./e2e-database-guard";
import {
  createTestFixtureAcceptance,
  seedPublishedPolicies,
} from "../prisma/legal-seed-content";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/campus_e2e?schema=public";

const E2E_REDIS_URL = process.env.E2E_REDIS_URL ?? "redis://localhost:6379";

const RUN_STATE_FILE = path.join("tests", "e2e", ".run-state.json");
const AUTH_DIR = path.join("tests", "e2e", ".auth");

function parseDatabase(url: string): { maintenanceUrl: string; name: string } {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, "");
  if (!name) {
    throw new Error(`E2E_DATABASE_URL 缺少数据库名: ${url}`);
  }
  parsed.pathname = "/postgres";
  return { maintenanceUrl: parsed.toString(), name };
}

async function ensureDatabase(): Promise<void> {
  const { maintenanceUrl, name } = parseDatabase(E2E_DATABASE_URL);

  try {
    // CREATE DATABASE 无法在事务中执行，走 prisma db execute 裸执行；
    // 已存在时报 42P04，直接吞掉。
    execSync("npx prisma db execute --schema prisma/schema.prisma --stdin", {
      input: `CREATE DATABASE "${name}";`,
      env: { ...process.env, DATABASE_URL: maintenanceUrl },
      stdio: ["pipe", "ignore", "pipe"],
    });
    console.log(`[e2e-setup] 数据库 ${name} 已创建`);
  } catch {
    // already exists 或权限问题——后续连通性校验会兜底
  }

  // 连通性校验：连不上给出可操作的提示
  try {
    const probe = new PrismaClient({ datasources: { db: { url: E2E_DATABASE_URL } } });
    await probe.$queryRaw`SELECT 1`;
    await probe.$disconnect();
  } catch (error) {
    throw new Error(
      `无法连接 E2E 数据库（${sanitizeDatabaseUrl(E2E_DATABASE_URL)}）：${error instanceof Error ? error.message : error}\n` +
        `本地请先 docker compose up -d postgres redis minio，并手动创建库：\n` +
        `  docker exec campus-marketplace-postgres createdb -U postgres ${name}\n` +
        `（已存在时会报错，可忽略）`,
    );
  }
}

function migrateDeploy(): void {
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
    stdio: "inherit",
  });
}

// 与 prisma/seed.ts 相同的外键安全顺序（含租赁模块全链）
async function wipeAll(prisma: PrismaClient): Promise<void> {
  await prisma.review.deleteMany();
  await prisma.report.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversationParticipant.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.order.deleteMany();
  await prisma.favorite.deleteMany();
  await prisma.rentalFavorite.deleteMany();
  await prisma.errandFavorite.deleteMany();
  await prisma.serviceFavorite.deleteMany();
  await prisma.productImage.deleteMany();
  await prisma.product.deleteMany();
  await prisma.errandTask.deleteMany();
  await prisma.serviceListing.deleteMany();

  await prisma.rentalReview.deleteMany();
  await prisma.rentalDispute.deleteMany();
  await prisma.rentalDamageClaim.deleteMany();
  await prisma.rentalExtensionRequest.deleteMany();
  await prisma.rentalReturnRecord.deleteMany();
  await prisma.rentalHandoverRecord.deleteMany();
  await prisma.rentalOrderStatusLog.deleteMany();
  await prisma.rentalOrder.deleteMany();
  await prisma.rentalUnavailablePeriod.deleteMany();
  await prisma.rentalListingImage.deleteMany();
  await prisma.rentalListing.deleteMany();

  await prisma.uploadedAsset.deleteMany();
  await prisma.userVerification.deleteMany();
  await prisma.adminLog.deleteMany();
  await prisma.blockedUser.deleteMany();
  await prisma.moderationKeyword.deleteMany();

  // NextAuth 表 + 全部用户（E2E 库完全由本脚本拥有）
  await prisma.account.deleteMany();
  await prisma.session.deleteMany();
  await prisma.verificationToken.deleteMany();
  await prisma.user.deleteMany();

  // Phase 5 治理表（acceptance 的 FK 指向 legalDocument 为 RESTRICT，先删子表）
  await prisma.policyAcceptance.deleteMany();
  await prisma.privacyRequest.deleteMany();
  await prisma.dataHold.deleteMany();
  await prisma.legalDocument.deleteMany();

  await prisma.productCategory.deleteMany();
  await prisma.errandCategory.deleteMany();
  await prisma.serviceCategory.deleteMany();
  await prisma.rentalCategory.deleteMany();
  await prisma.campus.deleteMany();
}

async function seedE2E(prisma: PrismaClient): Promise<void> {
  const campus = await prisma.campus.upsert({
    where: { slug: "main-campus" },
    update: { name: "主校区", schoolName: "示例大学", district: "华东校区" },
    create: {
      name: "主校区",
      slug: "main-campus",
      schoolName: "示例大学",
      district: "华东校区",
    },
  });

  await Promise.all(
    [
      ["教材资料", "books"],
      ["数码产品", "digital"],
      ["宿舍用品", "dorm"],
      ["交通工具", "transport"],
      ["服装鞋包", "fashion"],
      ["体育用品", "sports"],
      ["生活用品", "life"],
      ["其他闲置", "other"],
    ].map(([name, slug], index) =>
      prisma.productCategory.upsert({
        where: { slug },
        update: { name, sortOrder: index },
        create: { name, slug, sortOrder: index },
      }),
    ),
  );

  await Promise.all(
    [
      ["代取快递", "pickup-delivery"],
      ["代拿外卖", "takeout"],
      ["代打印", "printing"],
      ["代排队", "queue"],
      ["代买物品", "purchase"],
      ["搬运帮忙", "moving"],
      ["物品送达", "delivery"],
      ["其他校园任务", "other-errand"],
    ].map(([name, slug], index) =>
      prisma.errandCategory.upsert({
        where: { slug },
        update: { name, sortOrder: index },
        create: { name, slug, sortOrder: index },
      }),
    ),
  );

  await Promise.all(
    [
      ["摄影", "photography"],
      ["视频剪辑", "video-editing"],
      ["平面设计", "graphic-design"],
      ["PPT 制作", "ppt-design"],
      ["电脑维修", "computer-repair"],
      ["编程辅导", "programming-tutoring"],
      ["课程辅导", "course-tutoring"],
      ["乐器陪练", "music-practice"],
      ["健身陪练", "fitness-coaching"],
      ["活动协助", "event-support"],
      ["宠物照顾", "pet-care"],
      ["其他服务", "other-service"],
    ].map(([name, slug], index) =>
      prisma.serviceCategory.upsert({
        where: { slug },
        update: { name, sortOrder: index },
        create: { name, slug, sortOrder: index },
      }),
    ),
  );

  await Promise.all(
    [
      ["自行车 / 电动车", "bike", "自行车、电动车等交通工具"],
      ["相机 / 摄影器材", "camera", "单反、无人机、三脚架等摄影设备"],
      ["数码 / 电子设备", "electronics", "充电宝、投影仪、音响等电子设备"],
      ["教材 / 学习用品", "study", "教材、计算器、工程绘图仪等"],
      ["乐器", "music", "吉他、架子鼓、钢琴等各类乐器"],
      ["体育用品", "sports", "球类、健身器材、户外装备"],
      ["露营 / 户外", "outdoor", "帐篷、睡袋、炉具等露营装备"],
      ["服装 / 正装", "clothing", "西装、礼服、舞台服装等"],
      ["游戏 / 娱乐", "gaming", "游戏机、VR设备、桌游等"],
      ["工具 / 其他", "tools", "电钻、梯子等工具及其他物品"],
    ].map(([name, slug, description], index) =>
      prisma.rentalCategory.upsert({
        where: { slug },
        update: { name, description, sortOrder: index },
        create: { name, slug, description, sortOrder: index },
      }),
    ),
  );

  // Phase 5：先发布初始平台政策文档（fixture 同意需要文档已存在）
  await seedPublishedPolicies(prisma);
  console.log("[e2e-setup] 平台政策文档已发布（4 类 v1）");

  // E2E 确定性账号（仅存在于 E2E 库，production seed 保护不受影响）。
  // 密码与 tests/e2e/helpers/e2e.ts 的 E2E_ACCOUNTS 保持一致：
  // 公开的非生产测试凭据，可被 E2E_TEST_PASSWORD_PREFIX 覆盖。
  // withAcceptance=false 的账号用于 Phase 5 legacy re-consent 流程测试。
  const passwordPrefix = process.env.E2E_TEST_PASSWORD_PREFIX ?? "E2e";
  const accounts = [
    {
      email: "e2e-admin@e2e.test",
      name: "E2E管理员",
      password: `${passwordPrefix}Admin#2026`,
      role: UserRole.ADMIN,
      withAcceptance: true,
    },
    {
      email: "e2e-buyer@e2e.test",
      name: "E2E买家",
      password: `${passwordPrefix}Buyer#2026`,
      role: UserRole.STUDENT,
      withAcceptance: true,
    },
    {
      email: "e2e-seller@e2e.test",
      name: "E2E卖家",
      password: `${passwordPrefix}Seller#2026`,
      role: UserRole.STUDENT,
      withAcceptance: true,
    },
    {
      email: "e2e-outsider@e2e.test",
      name: "E2E无关用户",
      password: `${passwordPrefix}Outsider#2026`,
      role: UserRole.STUDENT,
      withAcceptance: true,
    },
    {
      // 【无同意记录】legacy 用户：登录后会被 consent gate 引导到 /legal/accept
      email: "e2e-legacy@e2e.test",
      name: "E2E老用户",
      password: `${passwordPrefix}Legacy#2026`,
      role: UserRole.STUDENT,
      withAcceptance: false,
    },
  ];

  for (const account of accounts) {
    const user = await prisma.user.create({
      data: {
        email: account.email,
        name: account.name,
        passwordHash: hashSync(account.password, 10),
        schoolName: campus.schoolName,
        campusId: campus.id,
        role: account.role,
        verificationStatus: VerificationStatus.VERIFIED,
      },
    });

    if (account.withAcceptance) {
      // 【TEST FIXTURE ACCEPTANCE】仅 E2E 基建使用，不代表生产 migration 语义
      await createTestFixtureAcceptance(prisma, user.id);
    }
  }

  console.log("[e2e-setup] E2E 账号已创建（5 个，legacy 无同意记录）");
}

async function flushRateLimitKeys(): Promise<void> {
  const redis = new Redis(E2E_REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    lazyConnect: true,
  });

  try {
    await redis.connect();
    // SCAN 游标遍历删除 ratelimit:*（登录/注册/上传限流计数），
    // 只清本项目命名空间，不动 Redis 其它数据
    let cursor = "0";
    let deleted = 0;
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "ratelimit:*", "COUNT", 100);
      cursor = next;
      if (keys.length > 0) {
        deleted += await redis.del(...keys);
      }
    } while (cursor !== "0");
    console.log(`[e2e-setup] 已清理 ${deleted} 个限流 Redis 键`);
  } catch (error) {
    console.warn(
      `[e2e-setup] Redis 清理跳过（${error instanceof Error ? error.message : error}）`,
    );
  } finally {
    redis.disconnect();
  }
}

async function main(): Promise<void> {
  assertE2EDatabaseIsolation(E2E_DATABASE_URL, process.env);
  // 日志禁止输出完整连接串（用户名/密码/query），只输出 sanitized 形式
  console.log(`[e2e-setup] E2E_DATABASE_URL=${sanitizeDatabaseUrl(E2E_DATABASE_URL)}`);
  await ensureDatabase();
  migrateDeploy();

  const prisma = new PrismaClient({ datasources: { db: { url: E2E_DATABASE_URL } } });
  try {
    await wipeAll(prisma);
    await seedE2E(prisma);
    console.log("[e2e-setup] 数据已重置（校区/分类/4 个 E2E 账号）");
  } finally {
    await prisma.$disconnect();
  }

  await flushRateLimitKeys();

  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(
    RUN_STATE_FILE,
    JSON.stringify({ startedAt: new Date().toISOString() }, null, 2),
  );
  console.log(`[e2e-setup] run-state 已写入 ${RUN_STATE_FILE}`);
}

main().catch((error) => {
  console.error("[e2e-setup] 失败:", error);
  process.exit(1);
});
