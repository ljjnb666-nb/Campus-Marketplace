#!/usr/bin/env bash
# =============================================================================
# 生产部署（scripts/ops/deploy.sh）
#
# 流程：
#   STEP 0  SOURCE ARTIFACT IDENTITY（RB-06 FINAL-01）：在任何生产副作用之前
#           证明 EXPECTED_SHA = 40-hex = 当前 checkout HEAD = 真实存在 commit，
#           且 worktree clean（无 tracked/staged 修改、无 untracked
#           build-context 文件）。构建内容因此来自该 commit，release 身份
#           不是调用者标签。
#   STEP 1  production env preflight（含 storage-cleanup worker interval 契约）
#   STEP 2  构建 immutable release artifact set（tag = GIT_SHA）：
#           app + migrate + storage-cleanup
#   STEP 3  备份当前数据库
#   STEP 4  migrate deploy（一次性容器，禁止 app 启动时并发迁移）+ 迁移验证
#   STEP 5  app 滚动更新
#   STEP 6  storage-cleanup worker 切换 + 运行时验证 + dry-run smoke
#           （worker 使用当前 schema：只在 migrate 完成后切换，绝不让新
#           worker 在迁移完成前接入生产库）
#   STEP 7  RELEASE READINESS GATE（scripts/ops/release-readiness-check.ts，
#           deploy 与 rollback 共用的唯一权威 verifier：health + ready +
#           release 身份 + 严格 ready + 全依赖 ok，fail closed）
#   STEP 8  记录 release 日志（仅 verifier PASS 后；记录 release artifact
#           pair：APP_IMAGE + CLEANUP_IMAGE + CLEANUP=running）
#
# FINAL REPAIR B：release 由两个不可变 runtime image 组成
#   campus-marketplace-app:<SHA> + campus-marketplace-cleanup:<SHA>
# （migrate 仍是一次性 migration artifact）。任何一步失败 → 不写 release log。
#
# 用法：./scripts/ops/deploy.sh [git_sha]   # 缺省 = 当前 HEAD；
#       显式传参只起 "assert expected checkout" 作用（必须等于 HEAD），
#       不能改变实际 release identity。
# 所有 env（SITE_ADDRESS/POSTGRES_* 等）从 .env.production 读取，无需手工 export。
# release identity chain（§30）：
#   git committed tree == clean checkout HEAD == GIT_SHA build arg ==
#   image tag == runtime RELEASE_SHA == health.release/ready.release。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
load_production_env

APP_URL="${APP_URL:-$(app_url_from_env)}"
# OPS_HEALTH_TIMEOUT 仅调整门禁等待预算（不能把失败变成功）：
# 必须是正整数，否则回默认；正则白名单保证无注入面。
HEALTH_TIMEOUT="${OPS_HEALTH_TIMEOUT:-120}"
if [[ ! "${HEALTH_TIMEOUT}" =~ ^[1-9][0-9]*$ ]]; then
  HEALTH_TIMEOUT=120
fi

EXPECTED_SHA_INPUT="${1:-}"

# -----------------------------------------------------------------------------
# STEP 0 — SOURCE ARTIFACT IDENTITY（fail closed，先于一切生产副作用）
# 1) 显式入参必须已是 40-hex（禁止截断任意输入后再接受）；
# 2) CURRENT_HEAD 必须可解析为 40-hex；
# 3) 显式入参（normalize 小写）必须等于 CURRENT_HEAD；
# 4) EXPECTED_SHA 必须是仓库中真实存在的 commit；
# 5) worktree 必须 clean（porcelain 为空；.env.production/.releases.log 等
#    由 .gitignore 管理不进 porcelain，不做手工 allowlist）。
# -----------------------------------------------------------------------------
echo "[deploy] step 0/7 source artifact identity 校验"
EXPECTED_SHA=""
if [[ -n "${EXPECTED_SHA_INPUT}" ]]; then
  if [[ ! "${EXPECTED_SHA_INPUT}" =~ ^[a-fA-F0-9]{40}$ ]]; then
    echo "[deploy][FAIL] INVALID_EXPECTED_SHA：release SHA 必须是 40 位 hex Git commit SHA（禁止短 SHA/分支名/unknown/dev/截断）" >&2
    exit 1
  fi
  EXPECTED_SHA="${EXPECTED_SHA_INPUT,,}"
fi

CURRENT_HEAD="$(git -C "${PROJECT_DIR}" rev-parse HEAD 2>/dev/null || true)"
if [[ ! "${CURRENT_HEAD}" =~ ^[a-fA-F0-9]{40}$ ]]; then
  echo "[deploy][FAIL] RELEASE_SOURCE_HEAD_UNRESOLVED：无法将 ${PROJECT_DIR} 的 HEAD 解析为 40 位 hex commit" >&2
  exit 1
fi

if [[ -n "${EXPECTED_SHA}" && "${EXPECTED_SHA}" != "${CURRENT_HEAD}" ]]; then
  echo "[deploy][FAIL] RELEASE_SOURCE_SHA_MISMATCH：请求 SHA=${EXPECTED_SHA} 与当前 checkout HEAD=${CURRENT_HEAD} 不一致——先 git checkout <release_sha> 再部署；远端 endpoint 自报的 release 不能覆盖本地 artifact identity" >&2
  exit 1
fi

EXPECTED_SHA="${CURRENT_HEAD}"

if ! git -C "${PROJECT_DIR}" rev-parse --verify --quiet "${EXPECTED_SHA}^{commit}" >/dev/null; then
  echo "[deploy][FAIL] RELEASE_SOURCE_COMMIT_NOT_FOUND：${EXPECTED_SHA} 不是仓库中真实存在的 commit" >&2
  exit 1
fi

if [[ -n "$(git -C "${PROJECT_DIR}" status --porcelain --untracked-files=normal)" ]]; then
  echo "[deploy][FAIL] RELEASE_SOURCE_TREE_DIRTY：worktree 存在未提交内容（tracked/staged 修改或 untracked build-context 文件会被 COPY . 带入镜像）——先提交或清理" >&2
  git -C "${PROJECT_DIR}" status --porcelain --untracked-files=normal >&2
  exit 1
fi

GIT_SHA="${EXPECTED_SHA}"

# -----------------------------------------------------------------------------
# 统一 release gate 调用：唯一权威 = scripts/ops/release-readiness-check.ts。
# 不提供任何 environment-selected verifier override（RB-06 FINAL-02：测试期
# verifier 可执行文件注入 seam 已从生产脚本移除，测试直接使用真实 verifier，
# 静态 gate 见 tests/ops/ops-scripts.test.ts）。
# -----------------------------------------------------------------------------
run_release_gate() {
  local expected_sha="$1"
  npx --prefix "${PROJECT_DIR}" tsx "${SCRIPT_DIR}/release-readiness-check.ts" \
    --base-url "${APP_URL}" \
    --expected-sha "${expected_sha}" \
    --timeout-seconds "${HEALTH_TIMEOUT}"
}

echo "[deploy] RELEASE_SHA=${GIT_SHA}"

# 1) preflight
echo "[deploy] step 1/7 生产 env 校验（含 storage-cleanup worker interval 契约）"
npx --prefix "${PROJECT_DIR}" tsx scripts/production-env-check.ts --file "${ENV_FILE}"

# 2) 构建不可变 release artifact set（GIT_SHA 进 build args，/api/health 可回报）
echo "[deploy] step 2/7 构建 release artifact set（tag=${GIT_SHA}：app + migrate + storage-cleanup）"
GIT_SHA="${GIT_SHA}" compose_run build app migrate storage-cleanup

# 3) 迁移（先备份，后迁移）
echo "[deploy] step 3/7 备份当前数据库"
"${SCRIPT_DIR}/backup-postgres.sh"

echo "[deploy] step 4/7 migrate deploy"
compose_run --profile ops run --rm migrate

# 迁移验证：再次执行必须显示 no pending migration
MIGRATE_OUT="$(compose_run --profile ops run --rm migrate 2>&1 || true)"
if ! echo "${MIGRATE_OUT}" | grep -qiE "No pending migrations|already in sync"; then
  echo "[deploy] 迁移重复执行未显示 no pending migration，请人工检查：" >&2
  echo "${MIGRATE_OUT}" >&2
  exit 1
fi
echo "[deploy] 迁移验证通过（no pending migration）"

# 5) app 滚动更新
echo "[deploy] step 5/7 滚动更新 app"
if ! GIT_SHA="${GIT_SHA}" compose_run up -d --no-deps --wait app; then
  echo "[deploy] app 启动失败，回滚见 scripts/ops/rollback.sh" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# 6) storage-cleanup worker：release artifact pair 的另一半。
# 顺序安全：migrate 已完成，新 worker 绝不会运行在 pre-migration schema 上。
# 每一步都 fail closed（镜像解析 / 启动 / running / exact image / dry-run
# smoke），任何失败 → 不写 release log。
# -----------------------------------------------------------------------------
echo "[deploy] step 6/7 切换 storage-cleanup worker（tag=${GIT_SHA}）"

# 6a) 镜像解析 assert：resolved image 必须精确等于 GIT_SHA tag
CLEANUP_IMAGES="$(GIT_SHA="${GIT_SHA}" compose_run config --images)" || {
  echo "[deploy][FAIL] compose config --images 解析失败，拒绝发布 cleanup worker" >&2
  exit 1
}
if ! printf '%s\n' "${CLEANUP_IMAGES}" | grep -Fxq "campus-marketplace-cleanup:${GIT_SHA}"; then
  echo "[deploy][FAIL] 解析后的 cleanup 镜像不是 campus-marketplace-cleanup:${GIT_SHA}（禁止 :local/:latest/异 SHA），拒绝发布" >&2
  exit 1
fi

# 6b) 切换
if ! GIT_SHA="${GIT_SHA}" compose_run up -d --no-deps storage-cleanup; then
  echo "[deploy][FAIL] storage-cleanup 启动失败——不写 release log" >&2
  exit 1
fi

# 6c) authoritative running 状态校验（compose ps，非"假定成功"）
RUNNING_SERVICES="$(compose_run ps --status running --services)"
if ! printf '%s\n' "${RUNNING_SERVICES}" | grep -qx "storage-cleanup"; then
  echo "[deploy][FAIL] storage-cleanup 未处于 running 状态，拒绝发布" >&2
  exit 1
fi
# 运行中容器的镜像身份必须精确匹配（防止 wrong image / 残留容器）。
# 注：GIT_SHA 前缀与 config --images 同模式——compose ps 本身不做插值，
# 显式传递使 release identity 与测试 stub 的插值模型保持同一契约。
if ! GIT_SHA="${GIT_SHA}" compose_run ps --format json storage-cleanup | grep -Fq "campus-marketplace-cleanup:${GIT_SHA}"; then
  echo "[deploy][FAIL] 运行中的 storage-cleanup 容器镜像不是 campus-marketplace-cleanup:${GIT_SHA}，拒绝发布" >&2
  exit 1
fi

# 6d) worker runtime smoke（--run-once --dry-run，零副作用）：证明 worker
# 镜像可启动 / Prisma client 可用 / DB 可达 / storage 配置可加载 /
# entrypoint 正确 / interval 配置合法。失败必须阻断发布；绝不以 mutation
# cleanup 作为发布 gate。
echo "[deploy] step 6/7 storage-cleanup runtime smoke（--run-once --dry-run，零副作用）"
if ! GIT_SHA="${GIT_SHA}" compose_run run --rm storage-cleanup --run-once --dry-run; then
  echo "[deploy][FAIL] storage-cleanup runtime smoke 失败（镜像/entrypoint/DB/storage/interval 配置）——不写 release log" >&2
  exit 1
fi
echo "[deploy] storage-cleanup worker 切换并验证通过"

# 7) RELEASE READINESS GATE（RB-06）：/api/health 200 不再等于 DEPLOY SUCCESS。
#    必须 health(ok + exact SHA) 且 ready(ready + exact SHA + DB/Redis/双 bucket 全 ok)。
#    注意：HTTP READINESS ≠ FULL RELEASE ARTIFACT VERIFICATION —— worker 的
#    runtime 状态已在上一步单独验证，/api/ready 不承载 worker 依赖。
echo "[deploy] step 7/7 release readiness gate（${APP_URL}）"
if ! run_release_gate "${GIT_SHA}"; then
  echo "[deploy][FAIL] deployment verification failed —— 不写 release log；" >&2
  echo "[deploy][FAIL] 处理后重试，或将应用切回上一 release：scripts/ops/rollback.sh <previous_git_sha>" >&2
  exit 1
fi

# release 日志（仅 verifier PASS 后才写；不记录 dependency URLs/credentials/bucket names）
LOG_FILE="${PROJECT_DIR}/.releases.log"
echo "$(date -Is) RELEASE_SHA=${GIT_SHA} APP_IMAGE=campus-marketplace-app:${GIT_SHA} CLEANUP_IMAGE=campus-marketplace-cleanup:${GIT_SHA} CLEANUP=running DEPLOYED_AT=$(date -Is) MIGRATION=deployed READINESS=ready" >> "${LOG_FILE}"
echo "[deploy] SUCCESS ${GIT_SHA}（release artifact pair 记录于 ${LOG_FILE}）"
