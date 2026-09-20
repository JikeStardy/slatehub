#!/bin/sh
set -e

# 必须 cd 到 backend/ 再跑:Bun 1.3.x 的 tsconfig 发现按 cwd 而非源文件目录,
# 从 /app 跑找不到 backend/tsconfig.json → experimentalDecorators 没启用 →
# NestJS 装饰器走 TC39 stage-3 语义 → descriptor.value undefined 直接炸。
# prisma 也是从 cwd 读 prisma.config.ts + prisma/schema.prisma,刚好同位置。
cd /app/backend

case "${SLATEHUB_RUN_MODE:-server}" in
  server)
    bunx prisma migrate deploy
    exec bun run src/main.ts
    ;;
  job)
    exec bun run scripts/job-runner.ts
    ;;
  *)
    echo "Unsupported SLATEHUB_RUN_MODE=${SLATEHUB_RUN_MODE:-server}. Use server or job." >&2
    exit 1
    ;;
esac
