# 回滚（Rollback）

> 前置：目标 release 所需的全部不可变镜像必须保留：`campus-marketplace-app:<git_sha>`、
> `campus-marketplace-cleanup:<git_sha>`（post-cleanup release）和
> `campus-marketplace-async-worker:<git_sha>`（post-async release）。
> 旧版本可以没有对应 worker，但不得把镜像丢失误判成“该版本无 worker”；
> 数据库 migration 纪律见 [PRODUCTION_DEPLOYMENT.md](./PRODUCTION_DEPLOYMENT.md)。
> 所有 env（SITE_ADDRESS/BACKUP_DIR/POSTGRES_*）由脚本从 `.env.production`
> 读取（经 `scripts/ops/lib.sh` 统一的 `--env-file` 约定），操作员无需手工 export。

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
| 已部署的迁移使旧 release 无法工作 | --hard：restore-production-postgres.sh 恢复最近备份，成功后才按目标 policy 切 writers |
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

## --hard 的数据安全语义

`./scripts/ops/rollback.sh <prev_sha> --hard`（仅 schema 不兼容时）：

1. 取 `BACKUP_DIR` 最新备份；**无备份直接中止**（绝不无备份覆盖生产库）
2. 30 秒取消窗口后调用 `restore-production-postgres.sh
   --production-restore --backup-file ... --target-db <生产库名>`：
   **停止全部 production DB writers（app + storage-cleanup + async-worker）并逐一验证 →**
   SHA256 强校验 → terminate 连接 → DROP/CREATE → restore → 完整性检查；
   任一 writer 无法停止 → FAIL CLOSED（绝不带着写流量 DROP）
3. **恢复失败（任一步非 0）→ 回滚立即中止，writers 切换绝不执行**，
   全部 production writers 保持停止状态等待人工介入
4. 恢复成功 → 以目标 commit 中的 worker 拓扑切换 app、cleanup、async-worker：
   已存在的 worker 必须 exact SHA，旧版不存在的 worker 必须保持停止；
   再执行严格 release readiness gate。**恢复失败后的停止状态禁止擅自重启。**

shell-level 回归测试（`tests/ops/rollback-restore.test.sh`）覆盖：safe 不碰 DB、
restore 失败阻断切换、restore 成功才切换、cleanup 与 app 成对切换到 exact SHA、
pre-worker 目标停止 cleanup、async-worker pre/post 目标切换及缺镜像拒绝、
任一 worker 切换失败不写 SUCCESS、缺备份 fail、SHA 不一致 fail、
缺显式确认 fail、writer 无法停止 → restore 不执行 DROP。

## 不可逆迁移的处理

如果某迁移确实不可逆（如删列/类型变更）：

1. 部署该迁移前的 release 必须通过"旧应用 + 新 schema"冒烟验证才允许继续；
2. 该迁移部署后，旧 release 视为不可回滚（.releases.log 中标记），
   故障时只能向前修复（hotfix）或 --hard 恢复备份；
3. 因此每个不可逆迁移上线前必须确认 deploy.sh 备份成功且 restore drill 最近一次 PASS。
