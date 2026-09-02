# 日志隐私与保留策略（Log Privacy & Retention）

> Phase 4 TASK 11。适用范围：应用结构化日志、Docker/Compose 容器日志、
> Caddy 反代日志、运维脚本输出、备份状态产物、metrics 输出。
> 状态：`IMPLEMENTED / PENDING_INDEPENDENT_REVIEW`。

## 1. 记什么（what gets logged）

- 应用：结构化 JSON 日志（契约见 docs/OBSERVABILITY.md §2）——运营里程碑
  （INFO）、可恢复降级（WARN）、服务端故障（ERROR，含 requestId/category）
- 探针：依赖失败事件 `dependency_health_failed`（正常探测零日志）
- 运维脚本：操作事实（备份开始/完成/失败 stage、部署 SHA、回滚目标）
- 容器层：Docker json-file 日志（上限见 compose.production.yml logging 配置）

允许的业务字段（最小必要）：requestId、orderId/conversationId 等**标识符**
（用于跨日志关联，非内容）、durationMs、statusCode、route family、
错误 category。禁止"顺手"多打：新日志字段需能回答"排障必需吗"。

## 2. 绝不记录（what never gets logged）

以下内容**禁止**进入任何普通日志/运维输出/metrics label（logger 出口
redaction 是兜底，不是许可）：

```text
校园认证原图 / 租赁交接证据 / 举报证据 / 任何 private asset 内容
password / password hash
完整 request body / 完整 FormData
Authorization 头 / Bearer token
Cookie / session token / NEXTAUTH_SECRET
DATABASE_URL / REDIS_URL（含内嵌密码形态）
S3 access key / secret key / presigned URL 的 X-Amz-* 查询签名
private objectKey 明文（如需关联，使用其不可逆短标识）
内部 stack 对用户界面的暴露（服务端日志允许 stack，见 §3 例外）
```

## 3. 保留与访问

| 层 | 保留 | 访问 |
| --- | --- | --- |
| 应用容器日志（json-file） | compose.production.yml logging 上限（max-size/max-file，超限轮转丢弃） | 服务器操作员（SSH/docker） |
| 宿主机 journal/system 日志 | 系统默认（建议 ≤30d） | 服务器操作员 |
| backup-status.json / .releases.log | 与备份/部署生命周期一致（无用户数据） | 服务器操作员 |
| 日志聚合（若未来接入） | 用户行为相关日志 **≤30 天**，之后删除或匿名化 | 按角色最小授权 |

- 用户行为日志**不无限期保存**：当前拓扑下容器日志自然轮转即上限；
  未来接入聚合平台时必须显式设置保留期与删除任务
- 事件访问（incident access）：处置期内按需读取；P0/P1 事后 postmortem
  引用的日志片段需先确认不含 §2 清单内容再写入文档

## 4. Redaction 契约

- `src/lib/logger.ts` 出口统一脱敏（键名擦除 + 值形态擦除 + 深度/长度上限），
  测试见 `src/lib/logger.observability.test.ts`（LOG_REDACTION_TEST）：
  Bearer/Cookie/DATABASE_URL/REDIS_URL/S3_SECRET_ACCESS_KEY/NEXTAUTH_SECRET/
  password/token/secret/AWS 凭据/presigned X-Amz-* 查询
- 契约：**新增敏感形态时先加测试再改实现**（防回归）
- metrics：label 白名单 + route family 折叠（无 userId/email/业务 ID），
  见 docs/OBSERVABILITY.md §5
- 探针/健康响应：只输出高层状态，无连接串/stack/SQL/凭据

## 5. 审查与例外流程

- 例外交道：调试确需临时输出敏感相关信息的场合，必须在受控窗口内、
  事后删除，且**永不**包含 §2 内容本体；优先使用 requestId 关联代替
- 定期（每次 Phase 验收）抽查：`docker compose logs app` 抽样 + grep
  §2 关键形态（Bearer/X-Amz-/postgres:// 等）确认零命中
