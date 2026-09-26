#!/usr/bin/env bash
# FINAL REPAIR B — LR-001 harness 辅助：
# 启动一个一次性 Caddy 容器（:8082 → host.docker.internal:3005），
# 复刻 deploy/Caddyfile 的 request_body max_size 12MB 生产契约，
# 用于 PRODUCTION_PROXY 通道证据。只在 harness 期间运行，不进 compose。
#
# 用法：bash scripts/resilience/start-harness-caddy.sh
# 停止：docker rm -f lr001-harness-caddy
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONF_DIR="$ROOT/bench-results/resilience"
mkdir -p "$CONF_DIR"

cat > "$CONF_DIR/Caddyfile.harness" <<'EOF'
:8082 {
	request_body {
		max_size 12MB
	}
	handle {
		reverse_proxy host.docker.internal:3005
	}
}
EOF

docker rm -f lr001-harness-caddy >/dev/null 2>&1 || true
# MSYS_NO_PATHCONV=1：Git Bash 会把容器内路径 /etc/... 误转换为主机路径
MSYS_NO_PATHCONV=1 docker run -d --name lr001-harness-caddy \
  -p 8082:8082 \
  -v "$CONF_DIR/Caddyfile.harness:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine \
  caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

for i in $(seq 1 20); do
  # 只确认 Caddy 容器自身在跑（upstream :3005 由 harness 稍后拉起）
  if [ "$(docker inspect -f '{{.State.Running}}' lr001-harness-caddy 2>/dev/null)" = "true" ]; then
    echo "harness caddy running on :8082"
    exit 0
  fi
  sleep 1
done
echo "harness caddy failed to start" >&2
docker logs lr001-harness-caddy >&2 || true
exit 1
