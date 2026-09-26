/**
 * FINAL REPAIR B（resilience harness 前置）：
 * 确保存在一个可用于真实 HTTP 上传 harness 的测试账号。
 *
 * 只创建/更新本 harness 专属账号（resilience-harness@campus.local），
 * 不触碰任何既有数据。密码随机生成（不硬编码），随登录凭据一起写入
 * bench-results/resilience/harness-user.json（已被 gitignore），
 * 供 upload-boundary-harness.mjs 等真实 HTTP harness 读取登录。
 */

import "dotenv/config";

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { hashSync } from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const USER_EMAIL = "resilience-harness@campus.local";
const CAMPUS_SLUG = "resilience-harness-campus";
const CREDENTIALS_PATH = path.join(
  process.cwd(),
  "bench-results",
  "resilience",
  "harness-user.json",
);

async function main() {
  const campus = await prisma.campus.upsert({
    where: { slug: CAMPUS_SLUG },
    update: {},
    create: {
      slug: CAMPUS_SLUG,
      name: "韧性测试校区",
      schoolName: "Resilience Harness University",
    },
  });

  // 每次运行轮换密码（仅存于本地 gitignored 文件）；已有账号则更新 hash
  const password = randomBytes(24).toString("base64url");

  await prisma.user.upsert({
    where: { email: USER_EMAIL },
    update: { status: "ACTIVE", deletedAt: null, erasedAt: null, passwordHash: hashSync(password, 10) },
    create: {
      name: "韧性测试用户",
      email: USER_EMAIL,
      passwordHash: hashSync(password, 10),
      schoolName: campus.schoolName,
      campusId: campus.id,
      role: "STUDENT",
      status: "ACTIVE",
    },
  });

  fs.mkdirSync(path.dirname(CREDENTIALS_PATH), { recursive: true });
  fs.writeFileSync(
    CREDENTIALS_PATH,
    JSON.stringify({ email: USER_EMAIL, password, campusId: campus.id }, null, 2),
  );

  console.log(JSON.stringify({ email: USER_EMAIL, credentialsFile: CREDENTIALS_PATH }));
}

main()
  .catch((error) => {
    console.error("[ensure-resilience-user] 失败:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
