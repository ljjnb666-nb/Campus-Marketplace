#!/usr/bin/env bash
# =============================================================================
# cleanup worker release provenance 回归（R2 评审修复
# CLEANUP_RELEASE_IDENTITY_RUNTIME_OVERRIDE）
#
# blocker：compose env_file 的变量优先级高于镜像 Dockerfile ENV，因此
# .env.production 里的 RELEASE_SHA 可以覆盖 baked 身份。修复合同：
# Dockerfile 把 GIT_SHA 写死进 /app/.release-sha，ENTRYPOINT 在容器 env
# 之上显式恢复并 export → worker 进程收到的身份只能来自 baked metadata。
#
# 本文件运行【真实 Docker 镜像】证明：
#   R2-ID-01  docker -e RELEASE_SHA=B（直接运行时覆盖）→ 日志 release = A
#   R2-ID-02  compose env_file（隔离 override，RELEASE_SHA=B）→ 日志 release = A
#   R2-ID-03  正常路径：HEAD 构建 → baked metadata == HEAD == 日志 release
#   FAIL-CLOSED  .release-sha 缺失 → 非零退出，worker 绝不启动，
#              无 dev/unknown/运行时值 fallback
#
# 由 tests/ops/ops-scripts.test.ts（vitest，bash+docker 可用时）调用并断言
# FAIL=0；也可在演练主机上手动执行：bash tests/ops/cleanup-release-provenance.test.sh
# 无 docker / bash 时打印 SKIP（基础设施不足，不算失败）。
#
# 隔离性：A/B 均为合成 40-hex，镜像用独立 tag，测试结束删除；
# R2-ID-02 通过 compose override 文件追加隔离 spoof env，
# 绝不修改真实 .env.production。
# =============================================================================
set -uo pipefail

PASS=0
FAIL=0
fail_test() { echo "FAIL: $1" >&2; FAIL=$((FAIL + 1)); }
pass_test() { PASS=$((PASS + 1)); }
assert_contains() {
  if printf '%s' "$2" | grep -qF "$1"; then pass_test; else fail_test "内容缺少: $1"; fi
}
assert_not_contains() {
  if printf '%s' "$2" | grep -qF "$1"; then fail_test "内容不应包含: $1"; else pass_test; fi
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$(mktemp)"
trap 'rm -f "${OUT}" "${REPO_ROOT}/r2prov-spoof.env" "${REPO_ROOT}/r2prov-override.yml"; docker rmi "${PROV_IMAGE}" >/dev/null 2>&1 || true' EXIT

# ---- 前提 ----
if ! command -v docker >/dev/null 2>&1; then
  echo "SKIP=1 FAIL=0 PASS=0（docker 不可用）"
  exit 0
fi
if [[ ! -f "${REPO_ROOT}/.env.production" ]]; then
  echo "SKIP=1 FAIL=0 PASS=0（无 .env.production）"
  exit 0
fi

# 合成 40-hex 身份（A = 镜像真实身份；B = 攻击者注入的伪造身份）
SHA_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa001"
SHA_B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb002"
PROV_IMAGE="campus-marketplace-cleanup-r2prov:${SHA_A}"

# ---- 构建 GIT_SHA=A 的镜像（层缓存命中，秒级）----
docker build --target cleanup-runner --build-arg GIT_SHA="${SHA_A}" \
  -t "${PROV_IMAGE}" "${REPO_ROOT}" > "${OUT}" 2>&1
if [[ $? -eq 0 ]]; then pass_test; else fail_test "R2-ID-01 前置：镜像构建失败"; fi

# ---- R2-ID-01：docker -e 直接运行时覆盖 → 日志 release 必须是 A ----
docker run --rm \
  -e RELEASE_SHA="${SHA_B}" \
  -e DATABASE_URL="postgresql://build-placeholder:build-placeholder@127.0.0.1:9/build" \
  "${PROV_IMAGE}" --run-once --dry-run > "${OUT}" 2>&1
RC=$?
assert_contains "storage_cleanup_worker_started" "$(cat "${OUT}")"
STARTUP="$(grep -oE '\{[^}]*storage_cleanup_worker_started[^}]*\}' "${OUT}" | tail -1)"
if [[ -n "${STARTUP}" ]]; then pass_test; else fail_test "R2-ID-01：未捕获启动日志行"; fi
assert_contains "\"release\":\"${SHA_A}\"" "${STARTUP}"
assert_not_contains "\"release\":\"${SHA_B}\"" "$(cat "${OUT}")"
assert_not_contains "\"release\":\"dev\"" "$(cat "${OUT}")"
assert_not_contains "\"release\":\"unknown\"" "$(cat "${OUT}")"
# run-once + 不可达 DB → 单周期失败退出（worker 既有语义），不影响身份断言
if [[ "${RC}" -ne 0 ]]; then pass_test; else fail_test "R2-ID-01：不可达 DB 下 run-once 竟 exit 0"; fi

# ---- FAIL-CLOSED：/app/.release-sha 缺失 → 非零退出，worker 绝不启动 ----
docker run --rm --entrypoint /bin/sh "${PROV_IMAGE}" \
  -c 'rm -f /app/.release-sha; set -eu; RELEASE_SHA="$(cat /app/.release-sha)"; export RELEASE_SHA; exec npx tsx scripts/ops/storage-cleanup-worker.ts --run-once --dry-run' \
  > "${OUT}" 2>&1
RC=$?
if [[ "${RC}" -ne 0 ]]; then pass_test; else fail_test "FAIL-CLOSED：metadata 缺失竟 exit 0"; fi
assert_not_contains "storage_cleanup_worker_started" "$(cat "${OUT}")"
assert_not_contains '"release":"dev"' "$(cat "${OUT}")"
assert_not_contains '"release":"unknown"' "$(cat "${OUT}")"

# ---- R2-ID-02：compose env_file 路径（隔离 override）→ 日志 release 必须是 A ----
# override 的 env_file 列表【替换】base：显式列出真实 .env.production +
# 隔离 spoof 文件（仅含 RELEASE_SHA=B，后者胜出），真实 env 文件零改动。
printf 'RELEASE_SHA=%s\n' "${SHA_B}" > "${REPO_ROOT}/r2prov-spoof.env"
cat > "${REPO_ROOT}/r2prov-override.yml" <<'YAML'
services:
  storage-cleanup:
    env_file:
      - .env.production
      - r2prov-spoof.env
YAML
GIT_SHA="${SHA_A}" docker compose --env-file .env.production \
  -f compose.production.yml -f r2prov-override.yml \
  run --rm --no-deps --build storage-cleanup --run-once --dry-run > "${OUT}" 2>&1
RC=$?
assert_contains "storage_cleanup_worker_started" "$(cat "${OUT}")"
STARTUP="$(grep -oE '\{[^}]*storage_cleanup_worker_started[^}]*\}' "${OUT}" | tail -1)"
if [[ -n "${STARTUP}" ]]; then pass_test; else fail_test "R2-ID-02：未捕获启动日志行"; fi
assert_contains "\"release\":\"${SHA_A}\"" "${STARTUP}"
assert_not_contains "\"release\":\"${SHA_B}\"" "$(cat "${OUT}")"
assert_not_contains "\"release\":\"dev\"" "$(cat "${OUT}")"
# compose 路径运行时身份必须来自镜像 bake，而非 spoof env_file
assert_not_contains "env_file cannot spoof" "$(cat "${OUT}")"

# ---- R2-ID-03：正常路径（HEAD）→ tag = baked = 日志 release 全一致 ----
HEAD_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
GIT_SHA="${HEAD_SHA}" docker compose --env-file .env.production \
  -f compose.production.yml build storage-cleanup > "${OUT}" 2>&1
if [[ $? -eq 0 ]]; then pass_test; else fail_test "R2-ID-03 前置：HEAD cleanup 镜像构建失败"; fi
BAKED="$(docker inspect --format '{{json .Config.Env}}' "campus-marketplace-cleanup:${HEAD_SHA}" | tr ',' '\n' | grep -oE 'RELEASE_SHA=[0-9a-f]{40}' | cut -d= -f2)"
if [[ "${BAKED}" == "${HEAD_SHA}" ]]; then pass_test; else fail_test "R2-ID-03：baked metadata != HEAD（实际 ${BAKED:-empty}）"; fi
GIT_SHA="${HEAD_SHA}" docker compose --env-file .env.production \
  -f compose.production.yml run --rm --no-deps storage-cleanup --run-once --dry-run > "${OUT}" 2>&1
assert_contains "\"release\":\"${HEAD_SHA}\"" "$(cat "${OUT}")"
assert_not_contains "\"release\":\"dev\"" "$(cat "${OUT}")"

echo "PASS=${PASS} FAIL=${FAIL}"
if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
exit 0
