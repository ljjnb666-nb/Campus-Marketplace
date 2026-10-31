# 生产恢复：旧凭据回退隔离与重新开放门禁（Issue #198）

状态：**工程候选、生产 UNVERIFIED / BLOCKED**。本文不是上线许可。

## 风险与不可变原则

从 T0 数据库备份恢复，会把 `User.passwordHash`、`User.email`、MFA 状态、RBAC 角色/租赁和账号状态等回滚至 T0。T1 用户可能已经改密、换邮箱、被收回权限或遭受账号安全事件。

因此恢复后**不能仅撤销旧 JWT/AccountSession**，否则从 T0 恢复的旧密码可再 mint 新 session。即便旧密码被隔离，历史邮箱/MFA/角色的回退仍须由独立生产身份审查处理，不能以本脚本通过替代。

## 本次安全防线

- `User.credentialRecoveryRequired` 非空布尔值，正常迁移默认 `false`。**灾后隔离账号不得通过普通邮箱重置自动解除**；禁止运营人员直接批量 UPDATE 解锁。未来解除隔离须先实现并独立验收外部不可回退身份/权限事实校验的专用恢复流程。
- `restore-production-postgres.sh` 在全体 writers 已停止、备份 SHA256 和真实 PG 还原校验后，**同一事务**将所有 `User.credentialRecoveryRequired=true`、撤销 `AccountSession` 并消费 `AccountChallenge`。任何表或字段缺失/更新异常 → 脚本非零失败、保留停止状态，禁止重新开放。
- 登录在 bcrypt 前拒绝隔离账户；**USER 治理锁内**的 finalizer 再核验 `credentialRecoveryRequired === false` 防止竞态或旧 bcrypt 成功后再登录；会话读取也拒绝隔离账号。不得通过重新签发 JWT 绕过。
- 普通未隔离账号的 `RESET_PASSWORD` 邮件挑战照常运行（15 分钟、一次性、哈希绑定、限流及 MFA）。**处于灾后隔离状态的账号既不能申请普通重置链接，也不能消费灾前已签发的重置链接解除隔离**；锁内二次拒绝。`VERIFY_EMAIL` 不得解除隔离。外部可信身份恢复流程尚未实现，故隔离账号保持不可登录，这是明确的可用性限制。
- 以上不会在恢复阶段自动批量生成新密码、泄露哈希或发送账户密码。

## 2026-10-30 临时封锁（P1）

在独立的外部身份、邮箱、MFA、RBAC 回退对账及经过独立审计的放行门禁实现之前，**正式生产 `rollback.sh <SHA> --hard` 已在任何恢复副作用前 fail closed**（`RECOVERY_EXTERNAL_IDENTITY_APPROVAL_REQUIRED`）。仅物理隔离的测试沙箱并提供专用恢复测试钩子时可复核旧流程；这不是生产放行许可，禁止把生产密钥或真实数据库配置导入沙箱来绕过封锁。

另外，**普通 safe rollback 也已增加目标 release 的凭据隔离兼容检查**，拒绝切换到不识别 `credentialRecoveryRequired` 的旧版本，防止灾后通过非破坏性回滚重新接受 T0 旧密码。此源文件门禁不能替代目标镜像内容证明。

这项代码是**临时阻断**，不等于外部审批机制实现，也不解决操作者绕过脚本、直接执行恢复和普通回滚的所有路径。正式恢复手册仍要求 writer 关闭、独立事件来源对账、人工事故指挥，以及将来实现不可从恢复库自证的发布授权和负向演练。Issue #198 继续 OPEN，生产 UNVERIFIED/BLOCKED。

## 2026-10-31 额外防误开放机制（单机封锁标记）

正式 `restore-production-postgres.sh` 在开始停止 writer/执行数据库破坏性操作之前，会创建宿主机本地 `.production-recovery-hold`，并且**不会自动删除**。同仓库的 `deploy.sh` 与 `rollback.sh` 在任何 Docker/数据库副作用前检查该标记；标记存在即返回 `RECOVERY_EXTERNAL_IDENTITY_APPROVAL_REQUIRED`。相应隔离脚本负向测试覆盖 deploy 和 safe rollback。

**重要限制**：标记是本机防误操作哨兵，不是不可伪造的审批证据，也不具备多宿主机一致性；有宿主机权限的人仍可能删除，直接 Docker/Compose、其他工作树以及手工启动不受此标记强制保护。生产事故不能自行删除标记后恢复服务。仍需实现外部不可回退身份/RBAC 权威来源、独立操作授权、跨宿主机封锁和不可被旧部署绕过的 runtime gate，才能申请生产放行。

## 2026-10-31 只读独立审计 P1-A/P1-C/P2-D 最小工程整改

- **P1-A / 固定宿主机标记**：正式生产恢复写入固定路径 `/var/lib/campus-marketplace/production-recovery-hold`，不再依赖 checkout/ `OPS_PROJECT_DIR`。生产恢复前必须由受控运维预先创建并限制 `/var/lib/campus-marketplace` 目录权限；无法写入标记会直接拒绝恢复。测试 `OPS_PROJECT_DIR` 只准指向物理独立且声明 `campus-ops-test-*` 或 `campus-restore-drill-*` 的 Compose 项目，拒绝生产项目名与 `COMPOSE_PROJECT_NAME` 覆盖。绝不可将真实生产环境变量、Docker Socket 或数据库密码放入测试沙箱。
- **P1-C / 镜像本机绑定**：成功部署后除 `.releases.log` 外还生成 `.release-image-ids.log`；记录 app、cleanup、async-worker、migrator 的 Docker `sha256` Image ID。回滚在切换任何 writer 之前核对两份历史日志与目标镜像当前 ID；缺少历史记录或标签重新指向其他 ID 则拒绝。早于该机制、缺少 ID 证据的历史 release 默认不能自动回滚，必须另经独立审核并构建可信发布工件。**Image ID 仍不是签名 provenance，也不证明 Dockerfile 的浮动 `node:24-bookworm-slim` 基础镜像与固定 Git tree 一致**；此项作为供应链残留风险继续阻断正式生产。
- **P2-D / 同步互斥**：备份与破坏性恢复在 `BACKUP_DIR/.backup-restore.lock` 使用同一 `flock -n`。锁已占用、目录缺失或锁无法获取即拒绝，恢复必须在停写与 DROP 前拿到锁。备份选取最新 dump 的人工审查仍不可省略；生产 `--hard` 在外部审批前继续停用。
- **边界**：这些检查仅覆盖受控宿主机、受控脚本；拥有 root/Docker 权限者、旧版脚本、第二宿主机和直接 Docker 操作仍可绕过。唯一充分方案仍需独立身份/RBAC 事实源、跨节点恢复授权与签名供应链/不可变镜像仓库验证；生产仍 `UNVERIFIED / BLOCKED`。

## 恢复/发布操作员门禁

1. 在独立演练环境先确认受影响账号集合、T0/T1 差异、凭据和授权事件的**外部不可回退证据**，评估失陷范围；现场备份、离站副本、通知系统和管理员操作权限均需审查。
2. 必须核验恢复目标 schema **包含** `User.credentialRecoveryRequired`；旧 schema 备份直接恢复时安全 SQL 会 fail closed，**不可自行临时删除此断言**。若需要从旧 schema 迁移，应另立有审查记录的隔离转换程序，先证明转换安全再允许任何 writer 重启。
3. 真实生产的 `app`、`storage-cleanup`、`async-worker` 停写和备份完整性必须独立确认；执行正式脚本后核验：
   `SELECT count(*) FROM "User" WHERE "credentialRecoveryRequired" IS DISTINCT FROM TRUE;` → **0**；旧 session/challenge 未消费数量 → 0。任何异常立即停止；不可打印用户哈希、邮箱或恢复令牌到日志。
4. `rollback.sh --hard` 还需在**任何恢复副作用之前**检查目标旧 release 的 `credential-login-service.ts`、`account-challenge-service.ts` 与 `account-session-service.ts` 是否支持 `credentialRecoveryRequired`，否则 `RECOVERY_CREDENTIAL_HOLD_TARGET_INCOMPATIBLE` 拒绝切换。该检查是保守的源码兼容门禁，不等于镜像已通过生产运行时审计；正常 safe rollback 也不能被当成恢复后放行捷径。
5. **不得因为脚本报告数据库恢复完成就重新开放登录或业务流量。** 在恢复的身份和 RBAC 历史状态与外部事实对齐、邮件送达和 MFA 验证能力恢复、受控用户恢复流程及滥用监测得到人工审批之前，保持生产 `BLOCKED`。
6. 对受影响账号，采用经批准的邮箱/MFA/人工补充核验程序重新确认真实归属；新密码验证后自动解除单账号 hold。历史邮箱可能已被弃用/转移，不能单凭从备份恢复出的旧邮箱确认所有者。
7. 检查恢复后未授权角色恢复、订单/支付凭据/对象存储或其他外部状态发生时间回退的影响。所有放行须记录审批人、准确 release SHA、证据位置、健康与安全指标、异常回滚计划。

## 可重复的隔离工程测试

- `tests/integration/production-restore-recovery-proof.test.ts`：提取**生产原 SQL** 至 disposable PG 运行、事务 rollback、缺字段 fail-closed；旧密码 hash 保留但隔离标记 true。
- `tests/ops/production-recovery-real.test.sh`：CI 专用真实 `pg_dump` T0 → T1 passwordHash rotation → `pg_restore` T0；验证旧 hash 被恢复，但 hold true、旧 session/challenge 失效。
- `tests/integration/account-security-lifecycle.test.ts`：真实 PG 旧密码 hash 相等时不能建立 session；灾前有效的 `RESET_PASSWORD` 链接不能解除隔离，灾后不签发普通重置链接；`VERIFY_EMAIL` 亦不解锁。
- `src/lib/credential-login-service.test.ts`、`src/lib/auth.test.ts`：fail-closed 单元边界。
- 不向真实生产写入 fixture，不重复使用生产用户数据。

## 已知残余

隔离验证不等于生产域名/TLS、跨实例登录限流、邮件到达、异地快照、历史邮箱/MFA 权威来源或权限撤销事件已恢复。Issue #198 在完整的外部身份/权限事实恢复策略和演练之前保持 **OPEN**；Issue #97/#115/#120/#157 仍独立 OPEN。
