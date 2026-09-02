import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { isWellFormedObjectKey } from "@/lib/storage/object-key";
import type {
  GetObjectResult,
  ObjectMetadata,
  ObjectRef,
  PutObjectInput,
  StorageClient,
} from "@/lib/storage/types";

const KNOWN_DEV_CREDENTIALS = "minioadmin";

/**
 * S3 兼容实现：MinIO（本地/CI）、AWS S3、Cloudflare R2 等共用同一套
 * 标准 S3 API。业务代码通过 StorageClient 接口访问，不直接依赖 SDK。
 */
export class S3Storage implements StorageClient {
  private readonly client: S3Client;

  constructor(client?: S3Client) {
    // 生产配置的权威校验在 env.ts 的 assertProductionStorageConfig（fail fast）。
    // 这里仅作防御性兜底：绕过 env 导入直接构造时仍然告警。
    if (process.env.NODE_ENV === "production" && env.S3_ACCESS_KEY_ID === KNOWN_DEV_CREDENTIALS) {
      logger.warn(
        "对象存储使用本地 MinIO 默认凭据（生产启动校验应已在 env 阶段拦截，请检查导入链）",
        "S3Storage",
      );
    }
    this.client =
      client ??
      new S3Client({
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
        credentials: {
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        },
      });
  }

  private assertRef(ref: ObjectRef): void {
    if (!ref.bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(ref.bucket)) {
      throw new Error("非法的 bucket 名");
    }
    if (!isWellFormedObjectKey(ref.objectKey)) {
      throw new Error("非法的 object key");
    }
  }

  async headBucket(bucket: string): Promise<boolean> {
    if (!bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
      return false;
    }
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
      return true;
    } catch {
      // readiness 只关心可达与否：凭据/网络/权限/桶缺失统一视为不可达
      return false;
    }
  }

  async putObject(input: PutObjectInput): Promise<void> {
    this.assertRef(input);
    await this.client.send(
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.objectKey,
        Body: input.body,
        ContentType: input.contentType,
        // Cache-Control 由调用方按访问级别显式提供（types.ts 契约），
        // 私有对象禁止落入任何公开缓存
        CacheControl: input.cacheControl,
      }),
    );
  }

  async deleteObject(ref: ObjectRef): Promise<void> {
    this.assertRef(ref);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: ref.bucket, Key: ref.objectKey }),
    );
  }

  async headObject(ref: ObjectRef): Promise<ObjectMetadata | null> {
    this.assertRef(ref);
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: ref.bucket, Key: ref.objectKey }),
      );
      return {
        sizeBytes: result.ContentLength ?? 0,
        contentType: result.ContentType ?? null,
      };
    } catch (error) {
      if (isNoSuchKeyError(error)) {
        return null;
      }
      throw error;
    }
  }

  async getObject(ref: ObjectRef): Promise<GetObjectResult | null> {
    this.assertRef(ref);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: ref.bucket, Key: ref.objectKey }),
      );
      const bytes = await result.Body!.transformToByteArray();
      return {
        body: Buffer.from(bytes),
        contentType: result.ContentType ?? null,
        sizeBytes: result.ContentLength ?? bytes.byteLength,
      };
    } catch (error) {
      if (isNoSuchKeyError(error)) {
        return null;
      }
      throw error;
    }
  }

  async getSignedReadUrl(
    ref: ObjectRef,
    expiresInSeconds: number,
    responseCacheControl?: string,
  ): Promise<string> {
    this.assertRef(ref);
    const command = new GetObjectCommand({
      Bucket: ref.bucket,
      Key: ref.objectKey,
      ...(responseCacheControl ? { ResponseCacheControl: responseCacheControl } : {}),
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }
}

function isNoSuchKeyError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotFound" || name === "NoSuchKey") {
    return true;
  }
  // SDK v3 把 404 归一化为 $metadata.httpStatusCode
  const metadata = (error as { $metadata?: { httpStatusCode?: number } } | null)
    ?.$metadata;
  return metadata?.httpStatusCode === 404;
}
