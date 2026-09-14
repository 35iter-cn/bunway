FROM node:22-slim AS dashboard
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
COPY apps/dashboard/package.json apps/dashboard/package.json
RUN pnpm install --frozen-lockfile --dangerously-allow-all-builds
COPY apps/dashboard apps/dashboard
RUN pnpm turbo build --filter=dashboard

FROM oven/bun:1 AS gateway
WORKDIR /app
COPY apps/gateway/package.json apps/gateway/tsconfig.json ./
COPY apps/gateway/src ./src
RUN bun build src/index.ts --target=bun --outfile=gateway.js

FROM oven/bun:1-slim
WORKDIR /app
COPY --from=gateway /app/gateway.js ./
COPY --from=dashboard /repo/apps/dashboard/dist ./static
RUN mkdir -p /data && chown 1000:1000 /data
USER 1000
ENV PORT=3001
ENV DB_PATH=/data/gateway.db
ENV STATIC_DIR=/app/static
EXPOSE 3001
CMD ["bun", "gateway.js"]