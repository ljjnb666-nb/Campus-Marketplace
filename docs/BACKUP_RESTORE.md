# 备份与恢复（Backup & Restore）

> 备份是 Phase 3 硬门禁：**只有实际执行过 restore drill 才允许标记 BACKUP_RESTORE PASS**。
> 部署流程见 [PRODUCTION_DEPLOYMENT.md](./PRODUCTION_DEPLOYMENT.md)。

## 1. 备份

脚本：`scripts/ops/backup-postgres.sh`（读取 `.env.production`）。

- 格式：`pg_dump -Fc`（custom，支持 pg_restore 选择性/并行恢复）
- 输出：`$BACKUP_DIR/<db>-<timestamp>.dump` + 同名 `.sha256` 校验文件
- 失败语义：空文件/命令失败一律退出非 0
- retention：本地默认 14 天（`BACKUP_RETENTION_DAYS`），过期自动清理
- 密码：pg_dump 在 postgres 容器内通过容器 env 认证，不落命令行/日志

### 3-2-1 基线

- 备份目录 `BACKUP_DIR` 必须在数据库磁盘之外的分区/挂载点。
- **异地副本**：设置 `BACKUP_OFFSITE_TARGET=s3://<bucket>/<prefix>`（需 AWS CLI）。
  错误语义（绝不产生虚假的异地备份安全感）：
  - 未配置 → 本地备份成功即成功，输出 `OFFSITE_NOT_CONFIGURED`
    （正式生产 PASS 必须报告"缺独立 off-host destination"）
  - 已配置但 aws CLI 缺失 / dump 上传失败 / checksum 上传失败 → **整体非 0 退出，
    本次备份判定 FAILED**，不得宣称备份成功
- 对象存储备份：使用外部 S3 提供商时优先开启提供商的版本化/跨区复制；
  自建 MinIO 时数据卷与数据库不得同盘且无异地副本就宣称生产就绪。

## 2. 恢复

两条独立路径，语义不同：

### 非生产目标（验证/演练）：`scripts/ops/restore-postgres.sh <backup.dump> <target_db>`

- 恢复前校验 `.sha256`
- **拒绝把 target_db 设为当前生产库名**（覆盖生产库必须走下述生产恢复入口）
- 恢复后自动核对：业务核心表逐一 COUNT（缺失即 FAIL）、
  `_prisma_migrations` 已完成迁移数（单独验证，> 0）、孤儿引用抽检

### 生产库恢复（唯一入口）：`scripts/ops/restore-production-postgres.sh`

强确认、顺序固定、任何一步失败立即非 0 退出：

```bash
./scripts/ops/restore-production-postgres.sh \
  --production-restore \
  --backup-file <backup.dump> \
  --target-db <POSTGRES_DB 的字面值>   # 显式确认生产目标
```

流程：SHA256 强校验（伴随文件必须存在）→ 停止 app 写流量 → 终止现存连接 →
DROP/CREATE → `pg_restore --exit-on-error` → 完整性检查（核心表 /
`_prisma_migrations` / 孤儿引用）。恢复失败时**应用保持停止状态**——绝不带
坏库恢复服务；`rollback.sh --hard` 在此脚本失败时会阻断应用切换。

## 3. Restore Drill（恢复演练）

脚本：`scripts/ops/restore-drill.sh [backup.dump]`——不影响生产库：

```
备份 → 独立验证库(restore_drill_<ts>) → pg_restore
     → 核心表计数 + 迁移记录 + 孤儿引用抽检 → DROP 验证库
```

报告字段：backup size / SHA256 / timestamp / restore target / 表计数 /
迁移数 / PASS-FAIL。

### 建议节奏

- 每次重大版本部署后跑一次 drill（deploy.sh 不强制包含，避免拉长部署窗口）
- 每月例行一次；验证库随时可删，成本约等于一次 restore

## 4. 与迁移的关系

- 恢复出的库自带 `_prisma_migrations` 记录，`migrate deploy` 会显示
  no pending migration——不要对恢复库执行 `db push` 强行对齐。
- 回滚场景（schema 不兼容的 --hard 路径）先恢复备份再切应用，见 ROLLBACK.md。
