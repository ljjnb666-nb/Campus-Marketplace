import { z } from "zod";

/** "true"/"1" → true，"false"/"0" → false，其余按原值交给 z.boolean() 报错 */
const booleanFromEnv = z.preprocess((value) => {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return value;
}, z.boolean());

/**
 * S3 兼容对象存储配置。
 * 默认值指向本地 docker compose 启动的 MinIO（开发/测试零配置），
 * 生产部署必须显式覆盖——S3Storage 初始化时对默认凭据发出告警。
 */
const s3EnvSchema = z.object({
  S3_ENDPOINT: z.string().default("http://localhost:9100"),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string().default("minioadmin"),
  S3_SECRET_ACCESS_KEY: z.string().default("minioadmin"),
  S3_BUCKET_PUBLIC: z.string().default("campus-public"),
  S3_BUCKET_PRIVATE: z.string().default("campus-private"),
  S3_FORCE_PATH_STYLE: booleanFromEnv.default(true),
});

const assetPolicyEnvSchema = z.object({
  // 公开对象的基础 URL（bucket 级），公开图片以此前缀拼接
  PUBLIC_ASSET_BASE_URL: z.string().default("http://localhost:9100/campus-public"),
  // 私有对象签名 URL 有效期（秒），安全默认 5 分钟
  PRIVATE_SIGNED_URL_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(86400)
    .default(300),
  // 每用户总上传配额（MB）
  STORAGE_QUOTA_MB: z.coerce.number().int().min(1).max(10240).default(500),
  // 未 attach 的临时资源保留时长（小时），超时由 cleanup 回收
  ASSET_ORPHAN_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  // 认证材料（学生证等敏感图片）在审核出结果后的保留天数
  VERIFICATION_ASSET_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3650)
    .default(30),
});

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  NEXTAUTH_URL: z.string().url(),
  NEXTAUTH_SECRET: z.string().min(16),
  APP_NAME: z.string().default("校园集市"),
  DEFAULT_CAMPUS_SLUG: z.string().default("main-campus"),
});

export const env = {
  ...envSchema.parse({
    DATABASE_URL: process.env.DATABASE_URL,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
    APP_NAME: process.env.APP_NAME,
    DEFAULT_CAMPUS_SLUG: process.env.DEFAULT_CAMPUS_SLUG,
  }),
  ...s3EnvSchema.parse({
    S3_ENDPOINT: process.env.S3_ENDPOINT,
    S3_REGION: process.env.S3_REGION,
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
    S3_BUCKET_PUBLIC: process.env.S3_BUCKET_PUBLIC,
    S3_BUCKET_PRIVATE: process.env.S3_BUCKET_PRIVATE,
    S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE,
  }),
  ...assetPolicyEnvSchema.parse({
    PUBLIC_ASSET_BASE_URL: process.env.PUBLIC_ASSET_BASE_URL,
    PRIVATE_SIGNED_URL_TTL_SECONDS: process.env.PRIVATE_SIGNED_URL_TTL_SECONDS,
    STORAGE_QUOTA_MB: process.env.STORAGE_QUOTA_MB,
    ASSET_ORPHAN_TTL_HOURS: process.env.ASSET_ORPHAN_TTL_HOURS,
    VERIFICATION_ASSET_RETENTION_DAYS:
      process.env.VERIFICATION_ASSET_RETENTION_DAYS,
  }),
};

export type Env = typeof env;
