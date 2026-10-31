# 生产定时运维交付模板

这些文件尚未安装到生产服务器，不能作为“备份、告警、恢复已上线”的证明。服务器准备后，由运维填写路径和凭据，在隔离环境验证，再安装并启用。当前项目仍是单机 Compose；单台主机故障会同时影响应用、数据库和本机备份。

## 配置与启用

1. Linux 主机准备 Docker Compose v2、Node.js 24、仓库锁定的构建工具、AWS CLI、`flock`。仓库放在 `/opt/campus-marketplace`；不同路径须同步修改所有 unit 的 `WorkingDirectory`。`.env.production` 与 `/etc/campus-marketplace/*.env` 仅 root 可读，不提交凭据。
2. 在 `.env.production` 配置 `BACKUP_DIR`、异地 `BACKUP_OFFSITE_TARGET=s3://独立账号或故障域的bucket/prefix`、保留期。存储侧启用版本保护/保留策略和最小权限凭据。备份脚本使用 `umask 077`；恢复校验 sidecar SHA256，校验失败不会建验证库。每日 03:00 只是模板，必须按批准的 RPO 调整；逻辑 dump 不等于 PITR。
3. 构建本次 release 的 `ops-runner` 镜像：`GIT_SHA=<完整SHA> docker compose --env-file .env.production -f compose.production.yml build ops-check`。在 `/etc/campus-marketplace/ops.env` 写 `OPS_RELEASE_SHA=<已部署完整SHA>`，每次成功发布/回滚同步更新。定时监控只运行已有镜像，禁止构建/拉取和自动启动被检查依赖。
4. `/etc/campus-marketplace/alert.env` 配置 `OPS_ALERT_WEBHOOK_URL=https://...`。接收器应接受 JSON `{event,unit,timestamp}`，转换为你的值班渠道并去重。脚本不发送业务日志/凭据，HTTPS 错误或非成功响应返回失败。必须安排外部存活监控覆盖宿主机宕机与告警服务自身失效；同机 systemd 不能报告断电。
5. 准备**另一个**隔离 Compose 项目（最好另一台主机），只包含测试 PostgreSQL。项目的 `name` 必须以 `campus-restore-drill-` 开头，不挂生产数据卷、不连接生产数据库。在 `/etc/campus-marketplace/restore-drill.env` 配置 `OPS_PROJECT_DIR=/隔离项目绝对路径`、`DRILL_OFFSITE_PREFIX=s3://bucket/prefix`、可选 `DRILL_MAX_BACKUP_AGE_HOURS=26`，以及仅可列出/下载该 prefix 的 AWS 角色。该项目的 `.env.production` 提供隔离 PostgreSQL 配置。演练脚本取异地最新 dump 与 checksum，拒绝过期备份，并仅在独立验证库还原/抽检，失败也清理自己创建的库。
6. 先用 `systemd-analyze verify deploy/systemd/*.service deploy/systemd/*.timer` 检查目标主机语法与二进制路径，再安装 unit。经人工确认目标配置后依次运行三个 service，保存备份异地对象、恢复耗时/行数、故障注入及实际告警送达证据，再启用对应 timer。检查 `systemctl list-timers` 和 journal；不得仅凭 unit 文件存在宣布已启用。

模板服务以 root 调用 Docker；持有 Docker socket 本身等价于主机管理权限。常驻 async/cleanup 镜像使用 UID 1000、只读根文件系统、无 Linux capabilities。仅一次性 ops-check 为读取 root 私有备份目录使用 root；备份目录只读挂载，不交给常驻 worker。

## 发布与失败处理

`deploy.sh` 固定本次迁移镜像 SHA，禁止运行时自动 build/pull，并在任何迁移/应用切换前停止和确认旧 async-worker。中途失败时 worker 保持停止，避免旧处理器消费新版本任务。应按日志确认数据库迁移与应用状态，再明确选择继续新发布或兼容回滚；不能无条件重启旧 worker。数据库迁移仍要求向前兼容，单实例应用切换会有短暂中断。

回滚按目标 Git commit 的 worker 入口判断历史拓扑；目标版本包含 worker 但镜像已被清理时必须失败。保留已部署版本和回滚版本的镜像及 Git 对象；镜像缺失不能被解释为“历史版本没有此组件”。

app、async、cleanup、ops 启动时都从镜像内 root 所有的 `.release-sha` 恢复身份，运行时 `RELEASE_SHA` 无法伪造。缺失 metadata 会拒绝启动。worker 在构建期编译为 JS，由实际外部导入生成最小依赖 manifest，再使用同源 lock、原 overrides 和 npm 安装；不携带 TS runner、Prisma CLI、测试工具或 Next.js。Prisma 生成引擎与依赖许可证保留在镜像。

## 上线证据门禁

复制 `deploy/production-evidence.example.json` 到受控证据存储，填写真实发布 SHA、记录链接、验收人和时间；不要把模板中的 `unverified` 自动改成通过。执行：

```sh
node scripts/ops/production-evidence-check.mjs /受控目录/evidence.json <完整发布SHA>
```

门禁要求公网 TLS/readiness、真实账号验证与密码恢复邮件投递、异地备份恢复、告警和值班、容量及 RPO/RTO、业务与隐私验收记录均已验证且不早于 30 天，任何缺失/过期/SHA 不符都失败。测试数据库充当的邮箱不能替代真实邮件投递证据。这是证据完整性检查，不验证附件真实性；证据内容需人工审核。可将它作为批准公开流量前的必需步骤；`deploy.sh` 的技术发布门禁不能代替这些业务和外部运维验收。

## 本地回归

`tests/ops/deploy-gate.test.sh`、`rollback-restore.test.sh`、`restore-drill.test.sh`、`offsite-drill.test.sh` 使用临时目录和命令 stub，不触碰生产服务。`production-evidence.test.ts` 对 webhook 使用替身，不发送外部消息。

`tests/ops/image-runtime.test.sh` 是 opt-in Docker 验收：预先构建 app/async/cleanup/ops/migrator 镜像，设置 `OPS_PROOF_IMAGE_PREFIX`、`OPS_PROOF_IMAGE_TAG`、`OPS_PROOF_EXPECTED_SHA`、已拉取的 `OPS_PROOF_MINIO_IMAGE` 后执行。它创建唯一名称的内部网络及临时 PostgreSQL/Redis/MinIO，发布零端口；验证真实迁移、worker 单周期、非 root/依赖收缩、身份防伪/缺失退出与 app health，退出时仅清理本次容器/网络。此结果只证明本地合成环境，不证明实际服务器上线条件。
