# tests/ops/docker-context-probe.Dockerfile
#
# RB-06 FINAL-03 canary probe：只验证仓库根 .dockerignore 的语义 ——
# Docker build context 必须是 committed git tree 的确定性投影
# （git ignored 的本地/运行时文件绝不进入 context）。
#
# FROM scratch：零基础镜像拉取、零网络依赖、零执行——
# 测试侧用 `docker create` + `docker export | tar -t` 列举 COPY 进 context
# 的全部文件，断言 canary 缺席、tracked placeholder 在场。
# 不修改 production Dockerfile；本文件仅供 provenance 测试使用。
FROM scratch
COPY . /context
