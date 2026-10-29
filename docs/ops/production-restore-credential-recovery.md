# 生产恢复：旧凭据回退隔离与重新开放门禁（Issue #198）

状态：**工程候选、生产 UNVERIFIED / BLOCKED**。本文不是上线许可。

## 风险与不可变原则

从 T0 数据库备份恢复，会把 `User.passwordHash`、`User.email`、MFA 状态、RBAC 角色/租赁和账号状态等回滚至 T0。T1 用户可能已经改密、换邮箱、被收回权限或遭受账号安全事件。

因此恢复后**不能仅撤销旧 JWT/AccountSession**，否则从 T0 恢复的旧密码可再 mint 新 session。即便旧密码被隔离，历史邮箱/MFA/角色的回退仍须由独立生产身份审查处理，不能以本脚本通过替代。

## 本次安全防线

- `User.credentialRecoveryRequired` 非空布尔值，正常迁移默认 `false`。此字段**只能在可信的密码重置完成交易**自动置回 `false`；不允许运营人员直接批量 UPDATE 解锁。
- `restore-production-postgres.sh` 在全体 writers 已停止、备份 SHA256 和真实 PG 还原校验后，**同一事务**将所有 `User.credentialRecoveryRequired=true`、撤销 `AccountSession` 并消费 `AccountChallenge`。任何表或字段缺失/更新异常 → 脚本非零失败、保留停止状态，禁止重新开放。
- 登录在 bcrypt 前拒绝隔离账户；**USER 治理锁内**的 finalizer 再核验 `credentialRecoveryRequired === false` 防止竞态或旧 bcrypt 成功后再登录；会话读取也拒绝隔离账号。不得通过重新签发 JWT 绕过。
- 现有 `RESET_PASSWORD` 邮件挑战（15 分钟、一次性、哈希绑定、限流；已启用 MFA 时仍需正确 TOTP）在**同一数据库事务**变更密码哈希、清除隔离标记、撤销全部旧 session。单独 `VERIFY_EMAIL` 不能清除标记。无法获得可信邮箱/MFA 的账号必须继续锁定，进入人工身份恢复流程。
- 以上不会在恢复阶段自动批量生成新密码、泄露哈希或发送账户密码。

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
- `tests/integration/account-security-lifecycle.test.ts`：真实 PG 旧密码 hash 相等时仍不能建立 session；完成 `RESET_PASSWORD` 后解除 hold、旧 hash 失效；仅 `VERIFY_EMAIL` 不解锁。
- `src/lib/credential-login-service.test.ts`、`src/lib/auth.test.ts`：fail-closed 单元边界。
- 不向真实生产写入 fixture，不重复使用生产用户数据。

## 已知残余

隔离验证不等于生产域名/TLS、跨实例登录限流、邮件到达、异地快照、历史邮箱/MFA 权威来源或权限撤销事件已恢复。Issue #198 在完整的外部身份/权限事实恢复策略和演练之前保持 **OPEN**；Issue #97/#115/#120/#157 仍独立 OPEN。
