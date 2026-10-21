FROM oven/bun:1.4.2-slim AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bunfig.toml tsconfig.json ./
COPY src ./src
USER bun
EXPOSE 3000
# SIGTERM chega direto no processo do Bun (exec form) para o graceful shutdown do Nest.
CMD ["bun", "src/main.ts"]
