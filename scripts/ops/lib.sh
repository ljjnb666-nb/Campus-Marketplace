#!/usr/bin/env bash
# =============================================================================
# 生产 ops 共享库（scripts/ops/lib.sh）——所有生产脚本 source 本文件。
#
# 统一两条约定（不得各自另写一套）：
# 1. 生产 env 只来自 <项目根>/.env.production，通过
#    docker compose --env-file <该文件> 提供给 Compose 模型插值；
#    service 级 env_file 只负责容器环境，不是插值来源。
# 2. 所有 docker compose 调用统一使用 compose_cmd 数组（含 --env-file）。
#
# OPS_PROJECT_DIR 仅供自动化测试注入沙箱项目目录（生产路径不受影响）。
# =============================================================================
set -euo pipefail

OPS_PROJECT_DIR="${OPS_PROJECT_DIR:-}"
# lib.sh 自身位于 scripts/ops/，据此定位项目根（不依赖调用方路径）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "${OPS_PROJECT_DIR}" ]]; then
  PROJECT_DIR="${OPS_PROJECT_DIR}"
else
  # lib.sh 位于 <项目根>/scripts/ops/，向上两级即仓库根
  PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
fi
ENV_FILE="${PROJECT_DIR}/.env.production"
COMPOSE_FILE="${PROJECT_DIR}/compose.production.yml"

# 解析 KEY=VALUE env 文件（去引号、跳过注释/空行；不 export 到当前 shell，
# 只输出到 stdout —— 调用方按需读取，避免把秘密整体倒进环境）
parse_env_file() {
  local file="$1"
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    # 去首尾空白
    line="$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" != *=* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    key="$(printf '%s' "$key" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    # 去成对引号
    if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' && ${#value} -ge 2 ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "${value:0:1}" == "'" && "${value: -1}" == "'" && ${#value} -ge 2 ]]; then
      value="${value:1:${#value}-2}"
    fi
    printf '%s=%s\n' "$key" "$value"
  done < "$file"
}

# 读取单个变量：shell 已 export 的值优先（显式覆盖），否则取 .env.production
require_env_var() {
  local name="$1" value=""
  # ${!name:-} 形式在 bash 中是非法间接展开，这里用 printenv 探测已 export 值
  if ! value="$(printenv "$name")"; then
    value=""
  fi
  if [[ -z "$value" && -f "$ENV_FILE" ]]; then
    value="$(parse_env_file "$ENV_FILE" | grep -E "^${name}=" | tail -1 | cut -d= -f2-)"
  fi
  if [[ -z "$value" ]]; then
    echo "[ops] 缺少必需变量 ${name}（shell 或 ${ENV_FILE}）" >&2
    return 1
  fi
  printf '%s' "$value"
}

# 可选变量：shell 显式 export 优先 → .env.production → 默认值。
# 供 BACKUP_RETENTION_DAYS 这类"有安全默认值的生产配置"使用，
# 不得绕过统一 env contract 直接写 ${VAR:-default}。
optional_env_var() {
  local name="$1" default_value="$2" value=""
  if ! value="$(printenv "$name")"; then
    value=""
  fi
  if [[ -z "$value" && -f "$ENV_FILE" ]]; then
    value="$(parse_env_file "$ENV_FILE" | grep -E "^${name}=" | tail -1 | cut -d= -f2-)"
  fi
  if [[ -z "$value" ]]; then
    value="$default_value"
  fi
  printf '%s' "$value"
}

load_production_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "[ops] 未找到 ${ENV_FILE}：请先 cp .env.production.example .env.production 并填写" >&2
    return 1
  fi
}

# 统一的 compose 调用前缀：
#   docker compose --env-file <.env.production> -f <compose.production.yml>
# Compose 模型插值（SITE_ADDRESS/POSTGRES_*/GIT_SHA 等）只从 --env-file 解析，
# 与 shell 环境是否 export 过这些变量无关。
compose_cmd() {
  printf 'docker compose --env-file %q -f %q' "$ENV_FILE" "$COMPOSE_FILE"
}

# 以数组形式执行 compose（脚本内使用）：
#   compose_run ps
compose_run() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

# 从 .env.production 推导公网 origin（操作员无需手工 export）
app_url_from_env() {
  local site_address
  site_address="$(require_env_var SITE_ADDRESS)"
  printf 'https://%s' "$site_address"
}

# All backup and destructive restore jobs on one host use the same flock inode.
# Do not move the lock relative to a selected backup filename or latest dump.
BACKUP_RESTORE_LOCK_NAME=".backup-restore.lock"

# Disaster-recovery hold belongs to the production HOST, not to a checkout.
# In production the path cannot be redirected using OPS_PROJECT_DIR.
# Sandboxes remain isolated and must declare an unambiguously non-production
# Compose project; COMPOSE_PROJECT_NAME would override its YAML name.
PRODUCTION_RECOVERY_HOLD_FILE="/var/lib/campus-marketplace/production-recovery-hold"
RECOVERY_HOLD_FILE="${PRODUCTION_RECOVERY_HOLD_FILE}"

check_ops_project_scope() {
  if [[ -z "${OPS_PROJECT_DIR}" ]]; then
    RECOVERY_HOLD_FILE="${PRODUCTION_RECOVERY_HOLD_FILE}"
    return 0
  fi
  local root scope compose_name
  root="$(cd "${SCRIPT_DIR}/../.." && pwd -P)"
  if ! scope="$(cd "${PROJECT_DIR}" && pwd -P)" || [[ "${scope}" == "${root}" ]]; then
    echo "[ops][FAIL] PRODUCTION_RESTORE_OVERRIDE_FORBIDDEN: invalid sandbox root" >&2
    return 1
  fi
  if [[ -n "${COMPOSE_PROJECT_NAME:-}" || ! -f "${COMPOSE_FILE}" ]] || { [[ -f "${ENV_FILE}" ]] && grep -Eq '^[[:space:]]*COMPOSE_PROJECT_NAME[[:space:]]*=' "${ENV_FILE}"; }; then
    echo "[ops][FAIL] PRODUCTION_PROJECT_OVERRIDE_FORBIDDEN: missing isolated Compose model or external project-name override" >&2
    return 1
  fi
  compose_name="$(awk '/^[[:space:]]*name:[[:space:]]*/ {print $2; exit}' "${COMPOSE_FILE}")"
  case "${compose_name}" in
    campus-restore-drill-*|campus-ops-test-*) ;;
    *) echo "[ops][FAIL] PRODUCTION_PROJECT_OVERRIDE_FORBIDDEN: sandbox requires isolated project name" >&2; return 1 ;;
  esac
  # This only scopes test adapters. Host administrators still can bypass a
  # shell script; it is not an external disaster-recovery approval authority.
  RECOVERY_HOLD_FILE="${scope}/.production-recovery-hold"
}

# Serialize all production writer lifecycle operations with destructive recovery.
# The backup/restore flock remains a separate nested lock: deploy holds this
# lifecycle lock while its backup subprocess takes only the backup lock.
# A production host must pre-provision /var/lib/campus-marketplace, writable
# only by the trusted ops account; NEVER fall back to a checkout-local lock.
OPS_LIFECYCLE_LOCK_NAME=".production-lifecycle.lock"
acquire_ops_lifecycle_lock() {
  check_ops_project_scope || return 1
  local lock_dir lock_path
  if [[ -n "${OPS_PROJECT_DIR}" ]]; then
    lock_dir="$(cd "${PROJECT_DIR}" && pwd -P)" || return 1
  else
    lock_dir="/var/lib/campus-marketplace"
  fi
  if [[ ! -d "${lock_dir}" || -L "${lock_dir}" ]]; then
    echo "[ops][FAIL] OPS_LIFECYCLE_LOCK_UNAVAILABLE: trusted host lock directory is missing" >&2
    return 1
  fi
  lock_path="${lock_dir}/${OPS_LIFECYCLE_LOCK_NAME}"
  if [[ -L "${lock_path}" ]]; then
    echo "[ops][FAIL] OPS_LIFECYCLE_LOCK_UNAVAILABLE: symlink lock is forbidden" >&2
    return 1
  fi
  if ! exec {OPS_LIFECYCLE_LOCK_FD}> "${lock_path}"; then
    echo "[ops][FAIL] OPS_LIFECYCLE_LOCK_UNAVAILABLE: cannot open host lock" >&2
    return 1
  fi
  if ! flock -n "${OPS_LIFECYCLE_LOCK_FD}"; then
    echo "[ops][FAIL] OPS_LIFECYCLE_LOCK_BUSY: a deploy, rollback or restore is already active" >&2
    return 1
  fi
}

require_no_production_recovery_hold() {
  check_ops_project_scope || return 1
  if [[ -e "${RECOVERY_HOLD_FILE}" || -L "${RECOVERY_HOLD_FILE}" ]]; then
    echo "[ops][FAIL] RECOVERY_EXTERNAL_IDENTITY_APPROVAL_REQUIRED: recovery hold exists; service restart/rollback prohibited until independently reviewed recovery procedure exists" >&2
    return 1
  fi
}

# Docker tags can be reassigned. Verify the content-addressed local image ID
# against BOTH recorded release logs before a rollback switches any writer.
release_image_id() {
  local id
  id="$(docker image inspect --format '{{.Id}}' "$1" 2>/dev/null)" || return 1
  [[ "$id" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  printf '%s' "$id"
}

require_release_image_inventory() {
  local sha="$1" key="$2" image="$3" manifest_line release_line expected release_id actual
  local inventory_file="${PROJECT_DIR}/.release-image-ids.log"
  local release_file="${PROJECT_DIR}/.releases.log"
  [[ -f "$inventory_file" && -f "$release_file" ]] || {
    echo "[ops][FAIL] RELEASE_IMAGE_ID_EVIDENCE_MISSING: no verified deployment inventory" >&2
    return 1
  }
  manifest_line="$(awk -v key="RELEASE_SHA=$sha" '{for(i=1;i<=NF;i++)if($i==key){print;break}}' "$inventory_file" | tail -n 1)"
  release_line="$(awk -v key="RELEASE_SHA=$sha" '{for(i=1;i<=NF;i++)if($i==key){print;break}}' "$release_file" | tail -n 1)"
  expected="$(printf '%s\n' "$manifest_line" | tr ' ' '\n' | grep -E "^${key}_IMAGE_ID=sha256:[0-9a-f]{64}$" | cut -d= -f2- | head -n 1)"
  release_id="$(printf '%s\n' "$release_line" | tr ' ' '\n' | grep -E "^${key}_IMAGE_ID=sha256:[0-9a-f]{64}$" | cut -d= -f2- | head -n 1)"
  if [[ -z "$expected" || "$expected" != "$release_id" ]]; then
    echo "[ops][FAIL] RELEASE_IMAGE_ID_EVIDENCE_MISSING: missing or inconsistent recorded image identity for $key" >&2
    return 1
  fi
  if ! actual="$(release_image_id "$image")" || [[ "$actual" != "$expected" ]]; then
    echo "[ops][FAIL] RELEASE_IMAGE_ID_MISMATCH: target image differs from verified deployment identity for $key" >&2
    return 1
  fi
}
