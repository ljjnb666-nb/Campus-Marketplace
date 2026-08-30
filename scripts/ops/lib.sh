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
