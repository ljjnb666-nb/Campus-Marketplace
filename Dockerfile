# syntax=docker/dockerfile:1

# =============================================================================
# Campus Marketplace production runtime
#
# 多阶段构建：
#   deps     — 完整依赖安装（复用给 builder / migrator）
#   builder  — next build（standalone 输出，NEXT_PHASE 跳过生产 env 断言）
#   runner   — 精简 standalone 运行时，非 root 用户，仅含生产所需文件
#   migrator — prisma migrate deploy 专用（compose 一次性 service 复用同一镜像）
#
# Release identity：构建时以 --build-arg GIT_SHA=<sha> 注入，
# 运行时通过 /api/health 的 release 字段可验证当前运行的 SHA。
# 秘密一律不进镜像（无 build args secrets、无 .env 复制），运行时通过 env 注入。
# =============================================================================

ARG NODE_VERSION=24

# ---------- deps ----------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- builder ----------
FROM node:${NODE_VERSION}-bookworm-slim AS builder
# Prisma 引擎依赖 openssl（page data 收集阶段会实例化 client）
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# GIT_SHA 只作为 release 标识 bake 进产物（公开信息），非秘密
ARG GIT_SHA=unknown
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PHASE=phase-production-build \
    RELEASE_SHA=${GIT_SHA}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# build 不连接真实数据库：占位值仅供 env 校验通过（真实连接在运行时注入）。
# 用 RUN 内 export：sh 的 VAR=x cmd 前缀只作用于单条命令；
# 不用 ENV 指令是避免 BuildKit SecretsUsedInArgOrEnv 对 "SECRET" 命名误报
# （占位值非秘密，且 runner 是独立 stage，任何 builder env 都不会进入最终镜像）
RUN export DATABASE_URL="postgresql://build-placeholder:build-placeholder@localhost:5432/build" \
        NEXTAUTH_URL="http://localhost:3000" \
        NEXTAUTH_SECRET="build-placeholder-secret-not-used-at-runtime" \
        NEXT_OUTPUT_STANDALONE=1 \
    && npx prisma generate \
    && npm run build

# ---------- runner ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runner
# Prisma 引擎依赖 openssl
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
ARG GIT_SHA=unknown
ENV RELEASE_SHA=${GIT_SHA}
RUN printf '%s\n' "${GIT_SHA}" > /app/.release-sha

# standalone 产物（自包含精简 node_modules）+ 静态资源
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

USER node
EXPOSE 3000

# 健康检查：/api/health = 真 liveness（只证明 app 进程存活 + release 可读），
# 不访问 PostgreSQL/Redis/S3——DB outage 不会把 app 容器误判为 unhealthy；
# 依赖级健康由 /api/ready 表达（DB/Storage 失败 → 503 not_ready）。
# slim 镜像无 curl/wget，用 Node fetch
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/bin/sh", "-c", "set -eu; RELEASE_SHA=\"$(cat /app/.release-sha)\"; export RELEASE_SHA; exec node server.js \"$@\"", "--"]

# ---------- migrator（一次性迁移任务）----------
FROM node:${NODE_VERSION}-bookworm-slim AS migrator
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY package.json prisma.config.ts ./
COPY prisma ./prisma
# deps has no OpenSSL and Prisma may select its 1.1 fallback there. Resolve the
# engines again in this OpenSSL 3 runtime at build time, so deployment never
# depends on downloading a missing schema engine from the public internet.
RUN export DATABASE_URL="postgresql://build-placeholder:build-placeholder@localhost:5432/build" \
    && npx prisma generate
# 只允许 migrate deploy（禁止 dev / db push），由 compose/ops 脚本触发
ENTRYPOINT ["npx", "prisma", "migrate", "deploy"]

# ---------- worker-builder（编译 TS；不进入常驻镜像）----------
FROM deps AS worker-builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts
RUN export DATABASE_URL="postgresql://build-placeholder:build-placeholder@localhost:5432/build" \
    && npx prisma generate \
    && node scripts/ops/build-runtime.mjs

# Install only locked production dependencies. Omit peer-only tooling as well:
# @prisma/client declares the Prisma CLI as an optional peer; --omit=dev alone
# retains that CLI and its build-tool dependency chain. Explicit runtime deps
# (including React required by Next) remain installed even if also peers.
# Generated Prisma engines come from worker-builder, with no runtime generation.
FROM node:${NODE_VERSION}-bookworm-slim AS worker-deps
WORKDIR /app
COPY --from=worker-builder /app/dist/ops/package.json /app/dist/ops/package-lock.json ./
COPY --from=deps /root/.npm /root/.npm
RUN npm ci --omit=dev --omit=peer --ignore-scripts --prefer-offline \
    && test ! -d node_modules/tsx \
    && test ! -d node_modules/prisma \
    && test ! -d node_modules/vitest \
    && test ! -d node_modules/next

# ---------- cleanup-runner（常驻非 root；仅生产依赖 + 编译后的入口）----------
FROM node:${NODE_VERSION}-bookworm-slim AS cleanup-runner
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=worker-deps /app/node_modules ./node_modules
COPY --from=worker-builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=worker-builder /app/dist/ops ./dist/ops
# Root-owned metadata cannot be rewritten by the worker. Runtime env is not the
# release authority; a missing metadata file must prevent startup.
ARG GIT_SHA=unknown
ENV RELEASE_SHA=${GIT_SHA}
RUN printf '%s\n' "${GIT_SHA}" > /app/.release-sha
USER node
ENTRYPOINT ["/bin/sh", "-c", "set -eu; RELEASE_SHA=\"$(cat /app/.release-sha)\"; export RELEASE_SHA; exec node dist/ops/storage-cleanup-worker.cjs \"$@\"", "--"]

# ---------- ops-runner（一次性只读诊断）----------
# BACKUP_DIR is root-only on the host; only this one-shot checker gets root to
# read its read-only bind mount. Neither long-running worker gets that mount.
FROM cleanup-runner AS ops-runner
ARG GIT_SHA=unknown
ENV RELEASE_SHA=${GIT_SHA}
USER root
ENTRYPOINT ["/bin/sh", "-c", "set -eu; RELEASE_SHA=\"$(cat /app/.release-sha)\"; export RELEASE_SHA; exec node dist/ops/ops-check.cjs \"$@\"", "--"]

# ---------- async-runner（常驻非 root；继承相同 immutable release metadata）----------
FROM cleanup-runner AS async-runner
ARG GIT_SHA=unknown
ENV RELEASE_SHA=${GIT_SHA}
USER node
ENTRYPOINT ["/bin/sh", "-c", "set -eu; RELEASE_SHA=\"$(cat /app/.release-sha)\"; export RELEASE_SHA; exec node dist/ops/async-worker.cjs \"$@\"", "--"]
