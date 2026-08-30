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

# 健康检查：/api/health（DB ping）；slim 镜像无 curl/wget，用 Node fetch
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
