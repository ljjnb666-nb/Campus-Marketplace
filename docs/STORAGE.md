# 对象存储设计（Production Phase 1）

本页面描述校园集市的文件存储体系：S3 兼容对象存储、公有/私有隔离、
上传配额、敏感文件生命周期。实现落点：

- `src/lib/storage/`：存储抽象（types / s3-storage / object-key / access-policy / index）
- `src/lib/image-processing.ts`：图片内容安全管线（decode / 重编码 / metadata 剥离）
- `src/lib/asset-service.ts`：资源登记、配额、业务绑定、删除生命周期、私有访问授权
- `src/lib/asset-cleanup.ts` + `scripts/storage-cleanup.ts`：清理任务
- `src/app/api/upload/images/` 与 `src/app/api/assets/[assetId]/access/`：上传与签名访问入口

## 1. 架构

```
Browser
  ↓ (multipart form)
Server Upload API  ──鉴权/限流──▶  Image Pipeline (sharp)
  ↓                                    │ magic bytes → decode → 像素上限
  ↓                                    │ → autoRotate → strip metadata → 重编码
Storage Abstraction (StorageClient)
  ↓
S3 兼容对象存储（MinIO / AWS S3 / Cloudflare R2 / OSS S3 网关）
  ↓
UploadedAsset 登记（Prisma）+ User.storageUsedBytes 配额记账
```

- 组件与页面**禁止**直接调用 S3 SDK；上传一律经 API/Action → asset-service → StorageClient。
- 本阶段上传通道为 Browser → Next.js → S3（服务端凭据）；高流量后再演进 presigned 直传。

## 2. public / private 分类

单一事实来源：`src/lib/storage/access-policy.ts` 的 `CATEGORY_ACCESS`。

| 分类 | 访问级别 | bucket | object key 前缀 |
|---|---|---|---|
| avatar | PUBLIC | campus-public | `public/avatars/{userId}/{uuid}.webp` |
| product | PUBLIC | campus-public | `public/products/{userId}/{uuid}.webp` |
| rental | PUBLIC | campus-public | `public/rentals/{userId}/{uuid}.webp` |
| service | PUBLIC | campus-public | `public/services/{userId}/{uuid}.webp` |
| verification | PRIVATE | campus-private | `private/verification/{userId}/{uuid}.webp` |
| handover | PRIVATE | campus-private | `private/handover/{userId}/{uuid}.webp` |
| return | PRIVATE | campus-private | `private/return/{userId}/{uuid}.webp` |
| report | PRIVATE | campus-private | `private/report/{userId}/{uuid}.webp` |

约束：

- object key 全部由服务器生成（UUID / crypto random），用户输入不参与路径拼接；
  `object-key.ts` 对 key 做白名单校验，任何 `..`、反斜杠、空段、控制字符一律拒绝（有单测覆盖）。
- PRIVATE 资源：不返回永久 URL、不落 `public/` 静态目录、DB 中只保存 `asset:<assetId>` 引用。
- 公开资源在业务表中保存完整公开 URL（`PUBLIC_ASSET_BASE_URL` 前缀，可切 CDN）。

## 3. 环境变量

| 变量 | 默认（本地 MinIO） | 说明 |
|---|---|---|
| S3_ENDPOINT | http://localhost:9100 | S3 兼容 API 端点 |
| S3_REGION | us-east-1 | 区域 |
| S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY | minioadmin | 服务端凭据（生产必须覆盖，使用默认值会告警） |
| S3_BUCKET_PUBLIC / S3_BUCKET_PRIVATE | campus-public / campus-private | bucket 名 |
| S3_FORCE_PATH_STYLE | true | MinIO/R2 为 true，AWS S3 通常 false |
| PUBLIC_ASSET_BASE_URL | http://localhost:9100/campus-public | 公开对象基础 URL（可指向 CDN） |
| PRIVATE_SIGNED_URL_TTL_SECONDS | 300 | 私有签名 URL 有效期（下限 60s） |
| STORAGE_QUOTA_MB | 500 | 每用户总上传配额 |
| ASSET_ORPHAN_TTL_HOURS | 24 | 未绑定业务资源的回收时限 |
| VERIFICATION_ASSET_RETENTION_DAYS | 30 | 认证材料审核后的保留天数 |

历史变量 `UPLOAD_DIR` 已废弃删除；生产上传不依赖本地磁盘。

## 4. MinIO 本地开发

```bash
docker compose up -d          # PostgreSQL + Redis + MinIO
docker compose up minio-init  # 幂等创建 bucket 并设置匿名策略（up -d 时已自动跑）
```

- S3 API：http://localhost:9100 ；Console：http://localhost:9101 （minioadmin/minioadmin）
- `minio-init` 一次性任务：`mc mb` 两个 bucket；`campus-public` 匿名策略 `download`
  （可读禁写），`campus-private` 策略 `none`（完全禁匿名）。

## 5. 上传流程（uploadImageAsset）

1. Auth（会话）+ 分类白名单
2. MIME 白名单 + 单文件大小上限（保留原有限额：avatar 5MB/1、product 10MB/9、
   rental 10MB/9、service 10MB/5、verification 5MB/2、handover 10MB/5、return 10MB/5、report 10MB/5）
3. sharp 真实 decode（magic bytes → 解码 → 像素上限 12000px / 40MP）
4. autoRotate + metadata 剥离 + 重编码（默认 WebP q85；带透明通道保留 PNG）
5. 配额原子预留（见 §7）
6. `putObject` 到对应 bucket
7. 写入 `UploadedAsset`（status=UPLOADED）
8. 返回 `{ assetId, access, url?, mimeType, sizeBytes }`；私有资源 `url=null`

前端 `ImageUploader` 选图后立即上传并把 token（公开 URL / `asset:<id>`）放进表单；
提交时服务端 `resolveImageTokens` 校验归属并把 UPLOADED 资源转成 ATTACHED（绑定业务实体）。
订单类照片（handover/return/claim/dispute）由 action 上传，maxCount 在服务端强制执行。

## 6. 私有资源签名访问

`GET /api/assets/{assetId}/access`（登录必需）：

1. 查 `UploadedAsset`：DELETED/PENDING_DELETE → 404
2. PUBLIC 资源 → 直接返回公开 URL
3. 过保留期（expiresAt）→ 410
4. 业务授权（`resolvePrivateAssetAccess`）：
   - VERIFICATION：资源本人、ADMIN
   - HANDOVER / RETURN / REPORT：资源本人、对应 RentalOrder 的 renter/owner、ADMIN
   - 其他 → 403
5. 签发短时签名 URL（默认 5 分钟），响应不泄露 objectKey

管理端 `admin/verifications` 通过 `PrivateAssetViewer` 客户端组件调本接口查看学生证材料。

## 7. 配额（并发安全）

- 记账字段：`User.storageUsedBytes`；判定用单条条件原子 UPDATE：

```sql
UPDATE "User" SET "storageUsedBytes" = "storageUsedBytes" + $size
WHERE id = $user AND "storageUsedBytes" + $size <= $quota
```

  行锁天然串行化，两个并发上传不可能同时通过判定（真实数据库集成测试：
  8 路并发 300KB、配额 1MB，恰好 3 路成功，记账精确 900000）。
- 释放走 `GREATEST(0, used - size)`，重复释放不会出现负数。

## 8. 孤儿回收（cleanup）

用户上传后未完成发品即离开 → 资源停留在 UPLOADED。
`npm run storage:cleanup`（支持 `--dry-run`）：

1. UPLOADED 且 createdAt 超过 `ASSET_ORPHAN_TTL_HOURS` → PENDING_DELETE
2. `expiresAt` 已过的敏感资源 → PENDING_DELETE
3. 所有 PENDING_DELETE → 删除远端对象 → DELETED + 释放配额

幂等：重复执行第二轮无操作；单条对象删除失败不中断批次，下轮自动重试。

## 9. 敏感材料保留期

管理员审核认证（通过/驳回）时，`applyVerificationAssetRetention` 给该认证的
资产打上 `expiresAt = 审核时间 + VERIFICATION_ASSET_RETENTION_DAYS`。
到期后 cleanup 删除证件原图，**认证结论（UserVerification.status）保留**。

## 10. 删除与失败恢复

| 场景 | 行为 |
|---|---|
| S3 上传失败 | 立即释放配额；不产生资源行（无脏数据） |
| DB 登记失败 | 删除已上传对象 + 释放配额（compensation） |
| 上传成功后进程崩溃 | 资源停留 UPLOADED → 孤儿回收 |
| 并发冲配额 | 条件 UPDATE 串行化，总量不突破 |
| 重复删除 | 状态机条件转移（UPLOADED/ATTACHED→PENDING_DELETE→DELETED），幂等 |
| cleanup 中途崩溃 | 已删对象的行已转 DELETED；未处理行下轮继续 |
| 签名 URL 泄漏 | 默认 5 分钟过期 |
| 猜测他人 assetId | 403/404，签名接口做业务授权 |
| 编辑替换/软删除业务实体 | 旧资源标记 PENDING_DELETE，异步物理清理，避免事务回滚后对象已删 |

原则：DB 与对象存储不会因失败形成无法恢复的不一致；
删除一律“先标记、后物理”，物理删除失败可重试。

## 11. 生产环境迁移（provider）

1. 建议顺序：先建 bucket（cloudfront/R2 等控制台）→ 设置私有 bucket 禁匿名 →
   覆盖 `S3_*` / `PUBLIC_ASSET_BASE_URL` 环境变量 → 部署 → 验证健康检查与一次上传。
2. AWS S3：`S3_FORCE_PATH_STYLE=false`，endpoint 可留空改用 region（当前实现要求 endpoint，可填
   `https://s3.<region>.amazonaws.com`）。
3. Cloudflare R2：path style true，endpoint 用账户级 S3 端点，公开访问走 R2 公开子域或 CDN。
4. 阿里云 OSS / 腾讯云 COS：使用其 S3 兼容网关 endpoint（后续如需原生 SDK，在
   `StorageClient` 接口下新增 adapter，业务代码零改动）。

## 12. 备份与恢复

- PostgreSQL：按既有数据库运维策略（pg_dump / 托管快照）。`UploadedAsset` 行是
  对象存储的权威索引，恢复 DB 即恢复可管理性。
- 对象存储：MinIO 用 `mc mirror` 定时同步；云厂商开 bucket 版本化 / 跨区复制。
- 恢复优先级：先恢复 DB（资源行、配额计数），再恢复对象；对象丢失但行存在的
  资源会保持 PENDING_DELETE 语义（head 为空时可视为已删除，配额以 DB 为准）。

## 13. 安全模型摘要

- 不信任客户端：MIME、magic bytes、decode、像素上限、大小、分类、数量全部服务端判定
- EXIF/GPS/相机信息在重编码时剥离（有测试：输入带 EXIF 输出无）
- object key 不可预测（UUID），路径穿越被白名单拒绝
- 私有对象无永久 URL；签名 URL 短时有效；接口做业务级授权
- 结构化日志只记录 assetId / userId / category / sizeBytes / operation / duration / errorCode，
  不记录签名 token、objectKey、原始文件内容或鉴权头
