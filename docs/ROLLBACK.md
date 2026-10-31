# 回滚（Rollback）

> 前置：目标 release 所需的全部不可变镜像必须保留：`campus-marketplace-app:<git_sha>`、
> `campus-marketplace-cleanup:<git_sha>`（post-cleanup release）和
> `campus-marketplace-async-worker:<git_sha>`（post-async release）。
> 旧版本可以没有对应 worker，但不得把镜像丢失误判成“该版本无 worker”；
> 数据库 migration 纪律见 [PRODUCTION_DEPLOYMENT.md](./PRODUCTION_DEPLOYMENT.md)。
> 所有 env（SITE_ADDRESS/BACKUP_DIR/POSTGRES_*）由脚本从 `.env.production`
> 读取（经 `scripts/ops/lib.sh` 统一的 `--env-file` 约定），操作员无需手工 export。

> **2026-10-31 安全状态：** 真实生产 hard rollback **禁止执行**。
> `rollback.sh <sha> --hard` 固定返回
> `RECOVERY_EXTERNAL_IDENTITY_APPROVAL_REQUIRED`；旧版数据库可含过期
> passwordHash、邮箱、MFA 和角色授权。没有外部不可回退身份/RBAC
> 真值对账、独立审批与凭据隔离解除流程之前，绝不恢复 writer/登录。
> 安全回滚也必须通过固定宿主机生命周期锁、恢复 hold 检查、
> 真实镜像 ID 双日志一致性和准确 release gate。
> 生产状态 `UNVERIFIED / BLOCKED`，Issue #198 仍 OPEN。

## 原则

1. **schema 只向前**。绝不自动执行 destructive down migration。
2. 每个迁移必须**向前兼容**旧 release：新列带默认值/可空、先加列再删列、
   不重命名（copy-over 而非 rename）。这样"旧应用 + 新 schema"可正常工作。
3. 安全回滚 = app / storage-cleanup / async-worker 按目标版本的生产拓扑切换，
   不支持的 worker 保持停止，数据库 schema 保持向前。
4. `scripts/ops/deploy.sh` 每次部署前自动备份，是 --hard 回滚的兜底。
5. **release identity 一致**：APP_RELEASE、CLEANUP_RELEASE 与 ASYNC_RELEASE
   不允许 split。回滚在启动 app 前先停稳原 async-worker，随后按目标 release
   策略切换 app / cleanup / async；每个运行中的 worker 都必须验证 running
   与运行镜像 exact SHA，任一失败即 ROLLBACK FAIL、禁止成功日志。

## cleanup worker 的目标 release policy

rollback 启动时先（只读）判定目标 release 的 cleanup artifact 是否存在：

| 目标 | 判定 | 动作 |
| --- | --- | --- |
| **post-worker** | `campus-marketplace-cleanup:<prev_sha>` 存在 | app 与 storage-cleanup 都切到 `<prev_sha>`，逐一验证 running **+ 运行容器 exact image**（cleanup 无 HTTP release endpoint，runtime identity 由 authoritative runtime inspection 提供）；release log 记录 `CLEANUP_IMAGE=... CLEANUP=running` |
| **pre-worker** | 该镜像不存在（首次上线 worker 前的 release） | app 切 `<prev_sha>`；**停止 storage-cleanup 并两阶段验证已停止**（`compose ps` 失败 ≠ 已停止，fail closed；恢复目标 release 的 runtime topology，不保留 newer worker）；release log 记录 `CLEANUP=stopped_pre_worker_release` |

## async-worker 的目标 release policy

必须先核验目标 40 位 Git commit 是否存在，再从该确切提交的
`scripts/ops/async-worker.ts` 判断目标是否支持 async worker：

| 目标 | 判定 | 动作 |
| --- | --- | --- |
| **post-async** | 目标 commit 包含 async-worker 源文件 | 目标 `campus-marketplace-async-worker:<prev_sha>` 镜像**必须存在**；先停止当前 worker 并验证、切 app/cleanup 后以目标镜像重启 async-worker；验证 running + runtime exact SHA；写 `ASYNC_WORKER_IMAGE=... ASYNC_WORKER=running` |
| **pre-async** | 目标 commit 不含 async-worker 源文件 | 停止当前 async-worker 并验证保持停止；禁止遗留 newer worker；写 `ASYNC_WORKER=stopped_pre_async_release` |
| **无权威提交或 post-async 缺镜像** | Git commit 不可证明或目标镜像已被清理 | **直接失败且不切换 app**；不能将“镜像未缓存”解释为“旧版本没有 worker” |

任何 `compose ps` 查询失败都是“状态未知”，不是“已停止”。

## 决策表

| 场景 | 动作 |
| --- | --- |
| 新 release 功能故障，schema 兼容 | 安全路径：`rollback.sh <prev_sha>`（不碰数据库；worker 成对切换/停止） |
| 新迁移尚未部署就发现坏 release | 直接 `rollback.sh <prev_sha>`（无 schema 变化） |
| 已部署的迁移使旧 release 无法工作 | **生产 hard rollback 已禁用**：停止切换并升级事故响应；先在隔离环境评估快照和 forward-fix，不得手工解锁或恢复 writer |
| 数据被应用 bug 破坏 | 恢复最近备份到临时库比对，做数据修复而非整库回滚 |

## 操作

```bash
# 1. 查看可回滚的 release（包括 async-worker 镜像与目标 commit）
docker images 'campus-marketplace-app'
docker images 'campus-marketplace-cleanup'
docker images 'campus-marketplace-async-worker'
git cat-file -e '<previous_git_sha>^{commit}'
tail .releases.log

# 2. 安全回滚（默认）：三个 writer 按目标 release 拓扑切换，不恢复数据库
./scripts/ops/rollback.sh <previous_git_sha>

# 3. 验证
curl -fsS https://<域名>/api/health   # release 应等于 previous_git_sha
docker compose --env-file .env.production -f compose.production.yml \
  ps --status running --services     # post-cleanup / post-async 目标应分别含对应 worker

# 4. 重新部署修复版
./scripts/ops/deploy.sh
```

## --hard 的数据安全语义（生产已停用，仅保留隔离测试合同）

`./scripts/ops/rollback.sh <prev_sha> --hard` 在真实生产路径会先以
`RECOVERY_EXTERNAL_IDENTITY_APPROVAL_REQUIRED` 拒绝；不执行数据库
DROP/RESTORE、不自动切 app 或任何 worker，也不会写成功日志。
原先关于“恢复成功自动切回 app/cleanup/async-worker”的历史方案
**不得按生产操作手册执行**。经隔离的模拟回归允许使用独立的
`OPS_PROJECT_DIR` / restore stub，但不构成生产授权。

单独的 `restore-production-postgres.sh` 仅在经批准的事故指挥下
用于**进入或维持生产隔离状态**：持有宿主机生命周期锁和
`BACKUP_DIR/.backup-restore.lock`，核验备份校验和，建立固定
`production-recovery-hold`，停止并逐一核验三个 writer，恢复数据库、
强制凭据隔离并撤销旧 session/challenge。任何失败均不得自动恢复服务；
停止前发生失败时不能宣称 writer 已经停止。

**上线前缺失项**：外部不可回退身份及 RBAC 事件真值、
独立事故审批与不可绕过的解封门禁、跨节点隔离证明、登录与邮件/MFA
真实演练及经过签名验证的发布工件。Issue #198 保持 OPEN。
相关证据和脚本边界见
[恢复凭据隔离手册](./ops/production-restore-credential-recovery.md)。

已存在的 shell-level tests 仍覆盖安全 rollback、旧版 hard 测试
fixture、备份完整性、writer 停止和恢复失败时 fail-closed；这些
测试仅验证**隔离工程行为**，不能升级生产信任等级。

## 不可逆迁移的处理

如果某迁移确实不可逆（如删列/类型变更）：

1. 部署该迁移前的 release 必须通过"旧应用 + 新 schema"冒烟验证才允许继续；
2. 该迁移部署后，旧 release 视为不可回滚（.releases.log 中标记），
   故障时只能向前修复（hotfix）或 --hard 恢复备份；
3. 因此每个不可逆迁移上线前必须确认 deploy.sh 备份成功且 restore drill 最近一次 PASS。
