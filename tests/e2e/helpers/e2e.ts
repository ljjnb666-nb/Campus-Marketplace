/**
 * E2E 共享常量与工具。
 * 账号只存在于 E2E 库（scripts/e2e-setup.ts 创建），生产环境不会生成。
 * 密码为公开的非生产测试凭据（可被 E2E_TEST_PASSWORD_PREFIX 环境变量覆盖），
 * 不用于任何真实系统——E2E 库每轮由 setup 全量重建。
 */

const E2E_PASSWORD_PREFIX = process.env.E2E_TEST_PASSWORD_PREFIX ?? "E2e";

export const E2E_ACCOUNTS = {
  admin: {
    email: "e2e-admin@e2e.test",
    password: `${E2E_PASSWORD_PREFIX}Admin#2026`,
    name: "E2E管理员",
  },
  buyer: {
    email: "e2e-buyer@e2e.test",
    password: `${E2E_PASSWORD_PREFIX}Buyer#2026`,
    name: "E2E买家",
  },
  seller: {
    email: "e2e-seller@e2e.test",
    password: `${E2E_PASSWORD_PREFIX}Seller#2026`,
    name: "E2E卖家",
  },
  outsider: {
    email: "e2e-outsider@e2e.test",
    password: `${E2E_PASSWORD_PREFIX}Outsider#2026`,
    name: "E2E无关用户",
  },
} as const;

/** storageState 文件（auth-setup 运行时生成，gitignore，禁止提交） */
export const AUTH_STATE_DIR = "tests/e2e/.auth";

export function storageStatePath(role: keyof typeof E2E_ACCOUNTS): string {
  return `${AUTH_STATE_DIR}/${role}.json`;
}

/**
 * 每次调用生成唯一短标签：spec 内创建的标题/邮箱必须携带，
 * 保证 --repeat-each 多轮与并行 worker 互不串数据。
 */
export function uniqueTag(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

/** 合成测试图片（非真实证件/照片，由 sharp 生成的纯色 JPEG） */
export const FIXTURE_IMAGES = {
  product: "tests/e2e/fixtures/images/product.jpg",
  verification: "tests/e2e/fixtures/images/verification.jpg",
  handover: "tests/e2e/fixtures/images/handover.jpg",
  return: "tests/e2e/fixtures/images/return.jpg",
} as const;
