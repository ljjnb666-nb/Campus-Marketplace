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

CMD ["node", "server.js"]

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
# 只允许 migrate deploy（禁止 dev / db push），由 compose/ops 脚本触发
ENTRYPOINT ["npx", "prisma", "migrate", "deploy"]

# ---------- cleanup-runner（存储清理 worker，常驻单实例）----------
# LR-071 审计修复：PENDING_DELETE 的生产自动恢复。与 migrator 同模型：
# 完整 node_modules（tsx 运行 TS 入口）+ prisma client + src/scripts 源码。
# 由 compose.production.yml 的 storage-cleanup 服务消费（backend 网络、
# 无端口、单实例、restart: unless-stopped），周期执行幂等的
# runStorageCleanup（详见 scripts/ops/storage-cleanup-worker.ts）。
# LR-R2（LAUNCH_REHEARSAL_REPAIR R2）：release identity bake 进 worker
# artifact（与 runner/migrator/ops-runner 同一 provenance 模式）——不可变
# image tag 是 campus-marketplace-cleanup:${GIT_SHA}，worker 结构化日志的
# release 字段（src/lib/logger.ts 读 RELEASE_SHA，缺省 "dev"）必须来自同
# 一构建期 GIT_SHA，否则新镜像的日志身份恒为 "dev"（launch rehearsal 实测）。
# RELEASE_SHA 是公开的 artifact 元数据（非秘密）；凭据绝不进构建期。
FROM node:${NODE_VERSION}-bookworm-slim AS cleanup-runner
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ARG GIT_SHA=unknown
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
# release identity 与不可变 image tag 同源（公开 artifact 元数据，非秘密）
ENV RELEASE_SHA=${GIT_SHA}
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts
# prisma.config.ts 加载即要求 DATABASE_URL：生成期使用占位值（非秘密，
# 运行时凭据一律由 compose env 注入），与 builder 阶段同模式
RUN export DATABASE_URL="postgresql://build-placeholder:build-placeholder@localhost:5432/build" \
    && npx prisma generate
ENTRYPOINT ["npx", "tsx", "scripts/ops/storage-cleanup-worker.ts"]

# ---------- ops-runner（一次性生产运维检查，compose ops-check 服务）----------
# LAUNCH_REHEARSAL_REPAIR R1（P1-01）：ops-check 的生产执行合同。
# 与 migrator/cleanup-runner 同模型（完整 node_modules + tsx 运行 TS 入口），
# 复用 cleanup-runner 的全部产物层（node_modules/prisma/src/scripts）。
# release identity 必须 bake 进 artifact（与 runner/migrator 同一 provenance
# 模式）：release_identity 检查读取的 RELEASE_SHA 来自构建期 GIT_SHA，
# 绝不允许运行时向无 provenance 的镜像注入任意身份。
# 诊断工件（非 production writer/runtime dependency）：不进入 deploy.sh
# 的 release artifact set，由 canonical 命令按需 --build（immutable
# GIT_SHA tag）。
FROM cleanup-runner AS ops-runner
ARG GIT_SHA=unknown
ENV RELEASE_SHA=${GIT_SHA}
ENTRYPOINT ["npx", "tsx", "scripts/ops/ops-check.ts"]
