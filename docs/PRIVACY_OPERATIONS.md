# 隐私运营手册（Privacy Operations）

> Production Phase 5 交付物。面向平台运营者/值班人员；
> 语义定义见 [DATA_GOVERNANCE.md](DATA_GOVERNANCE.md)、[LEGAL_GOVERNANCE.md](LEGAL_GOVERNANCE.md)。

## 1. 用户自助能力（无需运营介入）

| 能力 | 入口 | 行为 |
| --- | --- | --- |
| 查看协议 / 历史版本 | `/legal`、`/legal/<type>?version=N` | 公开可访问 |
| 查看同意历史 / 当前版本状态 | `/my/privacy` | 仅本人 |
| 导出本人数据 | `/my/privacy` → 导出按钮（`GET /api/privacy/export`，唯一执行入口） | 同步 JSON 下载；一次点击 = 恰好一条 COMPLETED 请求；3 次/15 分钟限流；>8MB 显式失败（请求记为 REJECTED） |
| 申请注销 | `/my/privacy` → 输入"注销账号"确认 | 同步执行：成功即匿名化完成 |
| 取消未执行请求 | `/my/privacy` 请求记录（REQUESTED 态） | 仅用户本人 |
| 重新同意 | `/legal/accept`（consent gate 自动引导） | 显式操作，绑定当前版本 |

用户隐私请求（`PrivacyRequest`）状态：REQUESTED / IN_PROGRESS / BLOCKED /
COMPLETED / CANCELLED / REJECTED；用户可在 `/my/privacy` 看到全部历史与
BLOCKED 原因（人类可读）。

**导出生命周期（REPAIR 后）**：同步导出在一次请求内完成
REQUESTED→IN_PROGRESS→COMPLETED（失败→REJECTED+reasonCode）。
`POST /api/privacy/requests` 不再接受 DATA_EXPORT（返回 `USE_EXPORT_ENDPOINT`
指引），不存在永远停在 REQUESTED 的导出记录。

## 2. 账号注销被 BLOCKED 时的处理

`reasonCode` 与处置：

| reasonCode | 含义 | 运营处置 |
| --- | --- | --- |
| `ACTIVE_DATA_HOLD` | 存在 active LEGAL/DISPUTE hold | 先处理对应法律/纠纷事项；确需放行时**先解除 hold**（见 §3），用户或运营再重试注销 |
| `ACTIVE_TRANSACTION_BLOCK` | 存在进行中订单/租赁订单 | 等交易完成/取消；用户可自行继续，或运营在交易闭环后重试 |

- BLOCKED 请求**保留**（不自动撤销），状态机 `BLOCKED → IN_PROGRESS → COMPLETED/REJECTED`；
- 重试入口：服务层 `retryBlockedRequest(requestId)`（治理 seam；Phase 7 后台
  落地前如需人工触发，由工程人员通过受控脚本调用并记录操作日志）；
- **绝不允许**为绕过 BLOCKED 而手动改库删除用户数据——破坏性操作只走
  eraseAccount 的事务路径。

## 3. Data Hold 操作（Legal / Dispute Hold）

- 创建：`createHold({ type: LEGAL|DISPUTE, subjectId, reasonCode, note })`（service seam）；
- 解除：`releaseHold(holdId, releasedById)`；
- 效果：active hold 阻断账号注销/擦除及（Phase 9 起）保留期自动清理；
- 审计：创建/解除均有结构化日志（`data_hold_created` 等，仅 IDs + reasonCode）；
- **禁止**：通过生产 debug endpoint 操作（Phase 5 不设此类 endpoint）；
  Phase 6/7 提供带 RBAC + AdminAuditLog 的管理界面后，操作迁移至后台。

运营检查清单（挂 hold 时）：

1. 记录 hold 原因与依据（内部工单/法务编号 → `note`）；
2. 确认 scope（当前仅 USER_ACCOUNT 级）；
3. 定期复核 active hold 列表，无依据的及时 release；
4. hold 期间用户请求注销 → 系统自动 BLOCKED，无需人工拦截。

## 4. 数据导出运营注意

- 导出内容边界由代码强制（显式 DTO + 禁止键扫描）；运营者**不需要也不应该**
  为用户手工拼装导出数据；
- 若用户报告导出失败 `DATA_EXPORT_TOO_LARGE`：记录 case，等待 Phase 9
  异步导出能力；不要用 DB 直查代替（泄漏风险）；
- 导出响应是 `private, no-store`——不得通过共享缓存/截图工具二次分发。

## 5. 注销后的数据状态（运营可见语义）

- 用户行保留、`erasedAt` 非空、展示名"已注销用户"、email 为
  `erased-<uuid>@erased.invalid`（不可反查）；
- 历史订单/评价/举报保留 pseudonymous 引用（治理与交易完整性）；
- active listings 已全部退出可交易状态；
- 该账号无法再登录（authorize + 每请求 DB 复核双重拦截）；
- 用户找回：**不可逆**。匿名化不保留恢复原 PII 的路径（这是特性不是缺陷）。

## 6. 事件与升级（Incident / Escalation）

| 事件 | 日志签名 | 处置 |
| --- | --- | --- |
| 注销被阻断 | `account_erasure_blocked`（reasonCode） | 按 §2 处置 |
| 注销完成 | `account_erasure_completed` | 无需行动；用户找回诉求按 §5 回应 |
| 导出被拒/失败 | `privacy_export_served` 缺失 + API 错误 | 查 requestId；确认是否 TOO_LARGE/限流 |
| hold 创建/解除 | `data_hold_created` | 核对是否有人误操作 |

- 隐私类 P1/P2 事件（疑似数据泄漏、越权导出）按
  [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md) 流程升级；
- 任何涉及导出/擦除的异常，先保留日志与 requestId，不要直接改业务数据。

## 7. 运营者可以 / 不可以做什么

**可以：**

- 通过 service seam / 受控运维脚本执行 hold 创建/解除与 BLOCKED 重试
  （并留操作记录）；
- 通过 seed 发布流程发布新版本法务文档（LEGAL_GOVERNANCE §2）；
- 查看 PrivacyRequest 台账与 BLOCKED 原因。

**不可以：**

- 手动 UPDATE/DELETE 用户 PII、"代用户"同意协议、伪造 acceptance
  （ consent 证据只能来自真实用户行为）；
- 绕过 eraseAccount 直接删用户行/级联清数据；
- 在日志、工单、聊天中粘贴导出 payload、验证材料、密码/token 等受限内容；
- 对外声称"已完全合规"（LEGAL_REVIEW_REQUIRED = TRUE 仍然成立）。

## 8. 上线前 checklist（隐私运营视角）

- [ ] 真实法律审查完成，基线文本被审查版替换（新版本发布）
- [ ] 生产环境已发布全部 4 类 required 文档（否则注册/同意门处于"无约束"状态）
- [ ] `GET /api/health`、`/api/ready` 正常；结构化日志中可见治理事件
- [ ] 备份/恢复演练覆盖新增治理表（Phase 3B 重开时执行）
- [ ] 运营值班人员已阅读本手册与 DATA_GOVERNANCE
