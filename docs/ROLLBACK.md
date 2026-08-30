# 回滚（Rollback）

> 前置：所有镜像以 `campus-marketplace-app:<git_sha>` 不可变 tag 保留最近数个
> release；数据库 migration 纪律见 [PRODUCTION_DEPLOYMENT.md](./PRODUCTION_DEPLOYMENT.md)。

## 原则

1. **schema 只向前**。绝不自动执行 destructive down migration。
2. 每个迁移必须**向前兼容**旧 release：新列带默认值/可空、先加列再删列、
   不重命名（copy-over 而非 rename）。这样"旧应用 + 新 schema"可正常工作。
3. 回滚 = 应用切回旧镜像 + 保留当前 schema（安全路径）。
4. `scripts/ops/deploy.sh` 每次部署前自动备份，是 --hard 回滚的兜底。

## 决策表

| 场景 | 动作 |
| --- | --- |
| 新 release 功能故障，schema 兼容 | 安全路径：`rollback.sh <prev_sha>` |
| 新迁移尚未部署就发现坏 release | 直接 `rollback.sh <prev_sha>`（无 schema 变化） |
| 已部署的迁移使旧 release 无法工作 | --hard：先 restore 备份（restore-postgres.sh）再切应用；人工评估后执行 |
| 数据被应用 bug 破坏 | 恢复最近备份到临时库比对，做数据修复而非整库回滚 |

## 操作

```bash
# 1. 查看可回滚的 release
docker images 'campus-marketplace-app'
tail .releases.log

# 2. 安全回滚（默认）：应用切旧镜像，schema 不动
./scripts/ops/rollback.sh <previous_git_sha>

# 3. 验证
curl -fsS https://<域名>/api/health   # release 应等于 previous_git_sha

# 4. 重新部署修复版
./scripts/ops/deploy.sh
```

`--hard` 路径（仅 schema 不兼容时，人工评估后）：
`./scripts/ops/rollback.sh <prev_sha> --hard` —— 先把最近备份恢复进当前
生产库（脚本有 30 秒取消窗口），再切应用。

## 不可逆迁移的处理

如果某迁移确实不可逆（如删列/类型变更）：

1. 部署该迁移前的 release 必须通过"旧应用 + 新 schema"冒烟验证才允许继续；
2. 该迁移部署后，旧 release 视为不可回滚（.releases.log 中标记），
   故障时只能向前修复（hotfix）或 --hard 恢复备份；
3. 因此每个不可逆迁移上线前必须确认 deploy.sh 备份成功且 restore drill 最近一次 PASS。
