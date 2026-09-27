#!/usr/bin/env bash
# =============================================================================
# 生产回滚（scripts/ops/rollback.sh）
#
# 用法：
#   ./scripts/ops/rollback.sh <previous_git_sha>          # 安全路径（默认）
#   ./scripts/ops/rollback.sh <previous_git_sha> --hard   # schema 不兼容时
#
# 安全路径（默认）：把 release artifact pair（app + storage-cleanup）切回旧
# 镜像；数据库 schema 保持向前（向前兼容 migration 约束见 docs/ROLLBACK.md），
# 完全不触碰数据库。
#
# --hard：仅当旧 release 与当前 schema 不兼容、需回退数据时使用：
#   1. 先执行 restore-production-postgres.sh（强确认、停写【app +
#      storage-cleanup 全部 production writers】、SHA256、完整性检查；
#      脚本任一步失败立即非 0 退出）
#   2. 恢复成功才允许按目标 release policy 切换 writers（app + cleanup）
#   3. 最后 RELEASE READINESS GATE 验证
# 恢复失败 → 立即非 0 退出，writers 切换绝不执行（全部保持停止，人工介入）。
# 绝不自动执行 destructive down migration。
#
# cleanup worker release consistency（FINAL REPAIR B）：
#   - campus-marketplace-cleanup:<PREVIOUS_SHA> 存在 → post-worker 目标：
#     app 与 storage-cleanup 必须同时切到 PREVIOUS_SHA，并逐一验证 running
#     + exact image；任一失败 → ROLLBACK FAIL，不写 release log
#   - 不存在 → pre-worker 目标：停止 storage-cleanup 并验证已停止（恢复目标
#     release 的 runtime topology），绝不保留 newer cleanup worker 运行
#
# PREVIOUS_SHA 必须是 40 位 hex Git commit SHA，且在任何 side effect
# （镜像检查/hard restore/writers switch/gate）之前校验；禁止截断任意输入。
# rollback 不重新构建 source，因此不要求 PREVIOUS_SHA == 当前 HEAD，
# 只要求它真实标识一个既有不可变镜像 tag。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"
load_production_env

# OPS_RESTORE_SCRIPT 仅供自动化测试注入 stub（生产路径不受影响）
RESTORE_SCRIPT="${OPS_RESTORE_SCRIPT:-${SCRIPT_DIR}/restore-production-postgres.sh}"

PREVIOUS_SHA="${1:?用法: rollback.sh <previous_git_sha> [--hard]}"
if [[ ! "${PREVIOUS_SHA}" =~ ^[a-fA-F0-9]{40}$ ]]; then
  echo "[rollback][FAIL] INVALID_EXPECTED_SHA：PREVIOUS_SHA 必须是 40 位 hex Git commit SHA（禁止短 SHA/分支名/unknown/dev/截断）" >&2
  exit 1
fi
PREVIOUS_SHA="${PREVIOUS_SHA,,}"
MODE="${2:-}"

if [[ "${MODE}" != "" && "${MODE}" != "--hard" ]]; then
  echo "[rollback] 未知模式: ${MODE}（可选：留空 = safe，--hard = 含数据回退）" >&2
  exit 1
fi

echo "[rollback] 回滚目标: ${PREVIOUS_SHA}（mode=${MODE:-safe}）"

# 旧镜像必须存在（不可变 tag 保留）
if ! docker image inspect "campus-marketplace-app:${PREVIOUS_SHA}" >/dev/null 2>&1; then
  echo "[rollback] 旧镜像 campus-marketplace-app:${PREVIOUS_SHA} 不存在" >&2
  echo "[rollback] 可用镜像: docker images 'campus-marketplace-app'" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# cleanup worker 目标 release 判定（只读，先于一切 side effect）：
#   campus-marketplace-cleanup:<PREVIOUS_SHA> 存在 → post-worker 目标
#   （rollback 必须同时切 worker）；不存在 → pre-worker 目标（停止 worker）。
# 首次上线 cleanup worker 后，回滚目标可能是 pre-worker release——不得因此
# 让 rollback 失效，也不得保留 newer cleanup worker 继续运行。
# -----------------------------------------------------------------------------
CLEANUP_TARGET_IMAGE="campus-marketplace-cleanup:${PREVIOUS_SHA}"
if docker image inspect "${CLEANUP_TARGET_IMAGE}" >/dev/null 2>&1; then
  CLEANUP_TARGET_MODE="post-worker"
else
  CLEANUP_TARGET_MODE="pre-worker"
fi
echo "[rollback] cleanup target mode = ${CLEANUP_TARGET_MODE}（${CLEANUP_TARGET_IMAGE}）"

APP_URL="${APP_URL:-$(app_url_from_env)}"
# OPS_HEALTH_TIMEOUT 仅调整门禁等待预算（不能把失败变成功）：
# 必须是正整数，否则回默认；正则白名单保证无注入面。
HEALTH_TIMEOUT="${OPS_HEALTH_TIMEOUT:-120}"
if [[ ! "${HEALTH_TIMEOUT}" =~ ^[1-9][0-9]*$ ]]; then
  HEALTH_TIMEOUT=120
fi

# 统一 release gate 调用：唯一权威 = scripts/ops/release-readiness-check.ts。
# 不提供任何 environment-selected verifier override（RB-06 FINAL-02：测试期
# verifier 可执行文件注入 seam 已从生产脚本移除，测试直接使用真实 verifier，
# 静态 gate 见 tests/ops/ops-scripts.test.ts）。
run_release_gate() {
  local expected_sha="$1"
  npx --prefix "${PROJECT_DIR}" tsx "${SCRIPT_DIR}/release-readiness-check.ts" \
    --base-url "${APP_URL}" \
    --expected-sha "${expected_sha}" \
    --timeout-seconds "${HEALTH_TIMEOUT}"
}

# -----------------------------------------------------------------------------
# 应用切换的唯一路径（safe 与 --hard 共用）：显式以目标 SHA 选择镜像。
#
# 不允许任何 fallback（:local / :unknown / 当前 HEAD / shell 残留的 GIT_SHA）：
# 1. 以 GIT_SHA=<target> 调 compose，让 image: campus-marketplace-app:${GIT_SHA:-local}
#    解析为准确 tag；
# 2. 在真正 up 之前用 compose config --images 读取插值后的最终镜像并 hard assert
#    必须等于 campus-marketplace-app:<target>，否则立即非 0 退出、不执行回滚。
# -----------------------------------------------------------------------------
switch_app_to() {
  local target_sha="$1" resolved_images=""

  if ! resolved_images="$(GIT_SHA="${target_sha}" compose_run config --images)"; then
    echo "[rollback][FAIL] compose config --images 解析失败，拒绝回滚" >&2
    exit 1
  fi

  if ! printf '%s\n' "${resolved_images}" | grep -Fxq "campus-marketplace-app:${target_sha}"; then
    echo "[rollback][FAIL] 解析后的 app 镜像不是 campus-marketplace-app:${target_sha}，拒绝回滚" >&2
    echo "---- resolved images ----" >&2
    printf '%s\n' "${resolved_images}" >&2
    echo "-------------------------" >&2
    exit 1
  fi
  echo "[rollback] resolved app image = campus-marketplace-app:${target_sha}"

  if ! GIT_SHA="${target_sha}" compose_run up -d --no-deps --wait app; then
    echo "[rollback] 应用启动失败（镜像 ${target_sha}）" >&2
    exit 1
  fi
}

# -----------------------------------------------------------------------------
# cleanup worker 切换的唯一路径（safe 与 --hard 共用，app 切换之后执行）：
# release identity 必须成对——APP_RELEASE 与 CLEANUP_RELEASE 不允许 split。
# post-worker 目标：config --images 精确断言 + up + running 验证 + 运行容器
# exact image 验证（cleanup 无 HTTP release endpoint，runtime identity 只能
# 由 authoritative runtime inspection 提供，同 deploy.sh 的验证链）；
# pre-worker 目标：停止 storage-cleanup 并两阶段验证已停止（compose ps 失败
# ≠ 已停止，绝不把命令失败解释成 cleanup stopped），不保留 newer worker。
# 任一步失败 → ROLLBACK FAIL（不写 release log）。
# -----------------------------------------------------------------------------
CLEANUP_LOG_TAG=""

switch_cleanup_to() {
  local target_sha="$1" resolved_images=""

  if [[ "${CLEANUP_TARGET_MODE}" == "pre-worker" ]]; then
    echo "[rollback] 目标 release 为 pre-worker：停止 storage-cleanup（恢复目标 release 的 runtime topology）"
    if ! compose_run stop storage-cleanup; then
      echo "[rollback][FAIL] storage-cleanup 停止命令失败，拒绝宣告回滚成功" >&2
      exit 1
    fi
    local running_services=""
    if ! running_services="$(compose_run ps --status running --services)"; then
      echo "[rollback][FAIL] 无法确认 storage-cleanup 停止状态（compose ps 失败），拒绝宣告回滚成功" >&2
      exit 1
    fi
    if printf '%s\n' "${running_services}" | grep -qx "storage-cleanup"; then
      echo "[rollback][FAIL] storage-cleanup 未停止，拒绝宣告回滚成功" >&2
      exit 1
    fi
    CLEANUP_LOG_TAG="stopped_pre_worker_release"
    echo "[rollback] storage-cleanup 已停止（pre-worker target）"
    return 0
  fi

  if ! resolved_images="$(GIT_SHA="${target_sha}" compose_run config --images)"; then
    echo "[rollback][FAIL] compose config --images 解析失败（cleanup），拒绝回滚" >&2
    exit 1
  fi
  if ! printf '%s\n' "${resolved_images}" | grep -Fxq "campus-marketplace-cleanup:${target_sha}"; then
    echo "[rollback][FAIL] 解析后的 cleanup 镜像不是 campus-marketplace-cleanup:${target_sha}，拒绝回滚" >&2
    echo "---- resolved images ----" >&2
    printf '%s\n' "${resolved_images}" >&2
    echo "-------------------------" >&2
    exit 1
  fi
  echo "[rollback] resolved cleanup image = campus-marketplace-cleanup:${target_sha}"

  if ! GIT_SHA="${target_sha}" compose_run up -d --no-deps storage-cleanup; then
    echo "[rollback] storage-cleanup 启动失败（镜像 ${target_sha}）" >&2
    exit 1
  fi
  if ! compose_run ps --status running --services | grep -qx "storage-cleanup"; then
    echo "[rollback][FAIL] storage-cleanup 未处于 running 状态，拒绝宣告回滚成功" >&2
    exit 1
  fi
  # 运行容器镜像身份必须精确匹配（cleanup 无 HTTP release endpoint，
  # 这里是唯一的 runtime identity 证据；GIT_SHA 前缀与 config --images /
  # deploy.sh 同一契约——compose ps 本身不做插值，显式传递使 release
  # identity 与测试 stub 的插值模型一致）。
  if ! GIT_SHA="${target_sha}" compose_run ps --format json storage-cleanup | grep -Fq "campus-marketplace-cleanup:${target_sha}"; then
    echo "[rollback][FAIL] 运行中的 storage-cleanup 容器镜像不是 campus-marketplace-cleanup:${target_sha}，拒绝宣告回滚成功" >&2
    exit 1
  fi
  CLEANUP_LOG_TAG="running"
}

if [[ "${MODE}" == "--hard" ]]; then
  echo "[rollback] --hard：先恢复最近备份到生产库（仅在旧 release 与当前 schema 不兼容时）" >&2
  BACKUP_DIR="$(require_env_var BACKUP_DIR)"
  latest_dump=""
  if ! latest_dump="$(ls -1t "${BACKUP_DIR}"/*.dump 2>/dev/null | head -1)"; then
    latest_dump=""
  fi
  if [[ -z "${latest_dump}" ]]; then
    echo "[rollback] BACKUP_DIR 中无可用备份，中止（绝不无备份覆盖生产库）" >&2
    exit 1
  fi
  echo "[rollback] 将恢复 ${latest_dump} → 生产库，并停止应用写流量"
  echo "[rollback] 30 秒内 Ctrl+C 取消"
  sleep 30

  # 关键路径：恢复失败必须阻断 writers 切换。restore-production-postgres.sh
  # 任一步失败都以非 0 退出，这里显式检查，绝不吞错。失败状态下全部
  # production writers（app / storage-cleanup）保持停止。
  if ! bash "${RESTORE_SCRIPT}" \
      --production-restore \
      --backup-file "${latest_dump}" \
      --target-db "$(require_env_var POSTGRES_DB)"; then
    echo "[rollback] 生产库恢复失败——writers 回滚已阻断（production writers 保持停止），人工介入" >&2
    exit 1
  fi
  echo "[rollback] 生产库恢复成功，按目标 release policy 切换 writers（mode=${CLEANUP_TARGET_MODE}）"
fi

# release artifact pair 切回目标 release（safe 路径唯一步骤；hard 路径在恢复
# 成功后到达这里）：先 app，后 cleanup（release identity 成对，不允许 split）
echo "[rollback] 应用切回 ${PREVIOUS_SHA}"
switch_app_to "${PREVIOUS_SHA}"
switch_cleanup_to "${PREVIOUS_SHA}"

# RELEASE READINESS GATE（RB-06）：回滚成功同样必须通过严格发布门禁——
# health(ok + PREVIOUS_SHA) 且 ready(ready + PREVIOUS_SHA + DB/Redis/双 bucket 全 ok)。
# /api/health 200 不再等于 ROLLBACK SUCCESS。
echo "[rollback] release readiness gate（${APP_URL}）"
if ! run_release_gate "${PREVIOUS_SHA}"; then
  echo "[rollback][FAIL] rollback verification failed —— 不写 release log；" >&2
  echo "[rollback][FAIL] app 已切回 ${PREVIOUS_SHA} 但依赖未就绪，人工检查后重试或回切" >&2
  exit 1
fi

if [[ "${CLEANUP_TARGET_MODE}" == "pre-worker" ]]; then
  echo "$(date -Is) ROLLBACK RELEASE_SHA=${PREVIOUS_SHA} APP_IMAGE=campus-marketplace-app:${PREVIOUS_SHA} CLEANUP=${CLEANUP_LOG_TAG} MODE=${MODE:-safe} READINESS=ready" >> "${PROJECT_DIR}/.releases.log"
else
  echo "$(date -Is) ROLLBACK RELEASE_SHA=${PREVIOUS_SHA} APP_IMAGE=campus-marketplace-app:${PREVIOUS_SHA} CLEANUP_IMAGE=campus-marketplace-cleanup:${PREVIOUS_SHA} CLEANUP=${CLEANUP_LOG_TAG} MODE=${MODE:-safe} READINESS=ready" >> "${PROJECT_DIR}/.releases.log"
fi
echo "[rollback] SUCCESS → ${PREVIOUS_SHA}（cleanup=${CLEANUP_LOG_TAG}）"
