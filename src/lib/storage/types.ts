/**
 * 存储抽象接口：业务代码只依赖此接口，不感知具体 S3 兼容实现
 * （MinIO / AWS S3 / Cloudflare R2 / 阿里云 OSS S3 网关等）。
 */

export interface ObjectRef {
  bucket: string;
  objectKey: string;
}

export interface PutObjectInput extends ObjectRef {
  body: Buffer;
  contentType: string;
  /**
   * 对象 Cache-Control 元数据。由调用方按访问级别显式给出：
   * PUBLIC → 长期公开不可变缓存；PRIVATE → 禁止存储。
   * 存储层不做任何猜测，避免私有对象被公开缓存策略污染。
   */
  cacheControl: string;
}

export interface ObjectMetadata {
  sizeBytes: number;
  contentType: string | null;
}

export interface StorageClient {
  /** 上传对象（服务端凭据，浏览器不持有任何 S3 密钥） */
  putObject(input: PutObjectInput): Promise<void>;

  /** 删除对象；对象不存在视为成功（幂等） */
  deleteObject(ref: ObjectRef): Promise<void>;

  /** 查询对象元数据；对象不存在返回 null */
  headObject(ref: ObjectRef): Promise<ObjectMetadata | null>;

  /**
   * 生成短时签名读 URL。
   * 仅允许用于 PRIVATE 对象；PUBLIC 对象使用公开 URL/CDN。
   * responseCacheControl 可覆盖响应头（S3 response-cache-control），
   * 私有对象应传 "private, no-store" 防止浏览器/代理长期缓存。
   */
  getSignedReadUrl(
    ref: ObjectRef,
    expiresInSeconds: number,
    responseCacheControl?: string,
  ): Promise<string>;
}
