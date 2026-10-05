# CI —— 调度合同与门禁不变量

本文记录 GitHub Actions CI（`.github/workflows/ci.yml`）的调度合同。
这些合同由静态 gate 锁定：`tests/ops/ci-workflow-contract.test.ts`
（CI 改动若破坏本文任一合同，`verify` job 内的测试会失败）。

## 门禁拓扑（CI-OPT-01 起）

```text
               ┌── verify (lint / typecheck / test / build) ──┐
PR / master ───┤                                              ├── 两个 gate 都必须 SUCCESS
               └── e2e (playwright critical paths) ───────────┘
```

`verify` 与 `e2e` 是相互独立的并行 gate：

- 两个 job 各自运行在独立 runner VM 上，`localhost:5432/6379/9100` 互不冲突。
- `verify` 使用服务容器数据库 `campus`；`e2e` 使用专用库 `campus_e2e`。
- `e2e` 全链路自包含（checkout → npm ci → Playwright install → 真实
  PostgreSQL / Redis / MinIO → prisma generate → production build →
  e2e setup → Playwright → teardown），不消费 `verify` 的任何 artifact。
- `needs: verify` 曾只是 sequencing，不是 correctness dependency，已于
  CI-OPT-01 移除；两个 gate 的 required check name 冻结不变（branch
  protection 按名字绑定，见下）。

### Fail-fast 语义

`verify` 失败时**不**人为取消仍在运行的 `e2e`：两个独立失败结果可以
提供更完整的诊断信息。`concurrency` 只取消旧 PR HEAD 的整条 run，
不取消同一 HEAD 的 sibling job。

## Stale PR run cancellation（CI-OPT-01 起）

```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

- **同一 PR**：group fallback = `pull_request.number`。push 新 HEAD 后，
  旧 HEAD 的 CI run 自动取消，新 HEAD 是 authoritative run。review →
  repair → push 循环不再堆积无效 runner 消耗。
- **不同 PR 之间**：group 按_pull_request number_ 隔离，互不取消。
- **master / 非 PR push**：group fallback = `github.run_id`（每次 run 唯一）。
  同 group 且 `cancel-in-progress=false` 时，GitHub 默认每个 group 只保留
  一个 pending run——连续 master pushes 会把旧 pending run 替换掉，
  丢失该 merge commit 的 evidence。run_id 唯一 group 使每个 merge commit
  的 post-merge CI 都有独立 group：**不仅保护 running 的 master run
  （不被 cancel），也保护尚未开始的 pending master run（不被 replace），
  每个 merge commit 都保留独立 exact-master post-merge CI evidence**。
  工程流程依赖
  `PR exact-head green → merge → exact-master post-merge CI → CLOSED`，
  master evidence 不可省略。

## 门禁不变量（静态 gate 锁定）

### verify（check name 冻结：`verify (lint / typecheck / test / build)`）

保留全部原 release gate，**禁止删减**：

1. `npm ci`
2. `npx prisma generate`
3. `npm run typecheck`
4. `npm run lint`
5. `npx prisma migrate deploy`（fresh）
6. `npx prisma migrate deploy`（幂等重跑——migration idempotency proof，
   不是无效重复）
7. `npm run test:coverage`（真实 PostgreSQL / Redis / MinIO 集成）
8. `npm run build`

### e2e（check name 冻结：`e2e (playwright critical paths)`）

保留全部原 release gate，**禁止弱化**：

- 真实 PostgreSQL（`campus_e2e`）/ 真实 Redis / 真实 MinIO（immutable
  digest pin）
- production build（非 dev server）
- `npm run e2e:setup`（migrate / reset / seed / rate-limit flush）
- `npx playwright test`（93 条关键链路）
- `npm run e2e:teardown`（`if: always()`）
- 失败工件上传（`if: failure()`）

两个 gate 的任何 step 都不得使用 `continue-on-error` / `|| true` /
allow-failure；check name 视为外部冻结合同，rename 会导致 branch
protection required checks 失效。

## 触发器（不变）

```yaml
on:
  push:
    branches: [master]
  pull_request:
```

即使 PR 已双绿，master merge commit 仍要跑完整 `verify + e2e`。
禁止用 `paths-ignore` / path filter 让 master evidence 静默缺失。

## 基线与实测耗时（CI-OPT-01）

所有时间取自 GitHub Actions metadata（run/job/step 的 started_at /
completed_at，workflow 墙钟 = createdAt → updatedAt），非估算。

基线（串行 topology，`e2e` 等待 `verify` 完成后才启动）：

| Run | 触发 | workflow 墙钟 | verify | e2e | 关键步骤 |
| --- | --- | --- | --- | --- | --- |
| 37310521724 | master push (2721084) | 15m41s(941s;12:34:57 → 12:50:38) | 9m55s | 5m42s | test:coverage 6m33s;Playwright 2m43s |
| 37307656636 | PR #63 (21b07d6) | 15m24s(924s;12:10:05 → 12:25:29) | 9m56s | 5m24s | test:coverage 6m32s;Playwright 2m37s |

并行化后实测（PR run 37316790078）：

| Run | 触发 | workflow 墙钟 | verify | e2e | overlap |
| --- | --- | --- | --- | --- | --- |
| 37316790078 | PR #64 (030fa8c) | 7m18s(438s;13:26:20 → 13:33:38) | 7m15s | 5m36s | YES(两 job 同秒启动；e2e 完成时 verify 仍在运行) |

节省（saved seconds，不是 optimized duration）：

- 对 master 基线：941 − 438 = **503s(53.5%)**
- PR 基线对比：924 − 438 = **486s(52.6%)**

healthy 墙钟 ≈ max(verify, e2e)，而非 verify + e2e；verify 单 job
时长的 run 间差异（如 9m55s → 7m15s）含 runner 波动成分，本阶段的
结构性主张由同秒启动的 overlap 直接证实。

## Runner 成本权衡

并行化使单 run 的 runner-minutes 总量基本不变或略增（两个 job 同时
占用 runner），换来的 developer feedback 墙钟明显下降；stale PR run
cancellation 则直接回收 review→repair 循环中旧 HEAD 的无效
runner-minutes。两者结合是 CI-OPT-01 的成立前提：**优化墙钟，而不是
通过增加跨 job coupling 换速度**（明确禁止 verify/e2e 共享 PG /
build artifact / mutable MinIO / Redis）。

## 刻意推迟（后续 CI-OPT-02+）

- docs-only fast path（path gating 与 required checks 交互需单独审计）
- Vitest / integration DB sharding（共享 PG 的跨套件干扰未根因前，
  禁止多 shard 共库；未来必须每 shard 独立 DB / Redis namespace / S3 namespace）
- Playwright cache 大改、Actions supply-chain pin、基础镜像 digest pin
- flaky policy（retries=2 维持不变；8F navigation flaky 根因与
  fail-on-flaky 独立项推进）
