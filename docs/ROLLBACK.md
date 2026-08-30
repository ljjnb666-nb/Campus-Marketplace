# 回滚（Rollback）

> 前置：所有镜像以 `campus-marketplace-app:<git_sha>` 不可变 tag 保留最近数个
> release；数据库 migration 纪律见 [PRODUCTION_DEPLOYMENT.md](./PRODUCTION_DEPLOYMENT.md)。
> 所有 env（SITE_ADDRESS/BACKUP_DIR/POSTGRES_*）由脚本从 `.env.production`
> 读取（经 `scripts/ops/lib.sh` 统一的 `--env-file` 约定），操作员无需手工 export。

## 原则

1. **schema 只向前**。绝不自动执行 destructive down migration。
2. 每个迁移必须**向前兼容**旧 release：新列带默认值/可空、先加列再删列、
   不重命名（copy-over 而非 rename）。这样"旧应用 + 新 schema"可正常工作。
3. 回滚 = 应用切回旧镜像 + 保留当前 schema（安全路径）。
4. `scripts/ops/deploy.sh` 每次部署前自动备份，是 --hard 回滚的兜底。

## 决策表

| 场景 | 动作 |
| --- | --- |
| 新 release 功能故障，schema 兼容 | 安全路径：`rollback.sh <prev_sha>`（不碰数据库） |
| 新迁移尚未部署就发现坏 release | 直接 `rollback.sh <prev_sha>`（无 schema 变化） |
| 已部署的迁移使旧 release 无法工作 | --hard：restore-production-postgres.sh 恢复最近备份，成功后才切应用 |
| 数据被应用 bug 破坏 | 恢复最近备份到临时库比对，做数据修复而非整库回滚 |

## 操作

```bash
# 1. 查看可回滚的 release
docker images 'campus-marketplace-app'
tail .releases.log

# 2. 安全回滚（默认）：应用切旧镜像，数据库完全不触碰
./scripts/ops/rollback.sh <previous_git_sha>

# 3. 验证
curl -fsS https://<域名>/api/health   # release 应等于 previous_git_sha

# 4. 重新部署修复版
./scripts/ops/deploy.sh
```

## --hard 的数据安全语义

`./scripts/ops/rollback.sh <prev_sha> --hard`（仅 schema 不兼容时）：

1. 取 `BACKUP_DIR` 最新备份；**无备份直接中止**（绝不无备份覆盖生产库）
2. 30 秒取消窗口后调用 `restore-production-postgres.sh
   --production-restore --backup-file ... --target-db <生产库名>`：
   停写 → SHA256 强校验 → DROP/CREATE → restore → 完整性检查
3. **恢复失败（任一步非 0）→ 回滚立即中止，应用切换绝不执行**，
   app 保持停止状态等待人工介入
4. 恢复成功 → 应用切旧镜像 → health / release 验证

shell-level 回归测试（`tests/ops/rollback-restore.test.sh`）覆盖：safe 不碰 DB、
restore 失败阻断切换、restore 成功才切换、缺备份 fail、SHA 不一致 fail、
缺显式确认 fail。

## 不可逆迁移的处理

如果某迁移确实不可逆（如删列/类型变更）：

1. 部署该迁移前的 release 必须通过"旧应用 + 新 schema"冒烟验证才允许继续；
2. 该迁移部署后，旧 release 视为不可回滚（.releases.log 中标记），
   故障时只能向前修复（hotfix）或 --hard 恢复备份；
3. 因此每个不可逆迁移上线前必须确认 deploy.sh 备份成功且 restore drill 最近一次 PASS。
