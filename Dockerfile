FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/providers-razorpay/package.json packages/providers-razorpay/
COPY packages/providers-whatsapp/package.json packages/providers-whatsapp/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/
RUN pnpm install --frozen-lockfile

FROM deps AS runtime
WORKDIR /app
COPY . .
RUN addgroup -S atlas && adduser -S atlas -G atlas && mkdir -p /data && chown -R atlas:atlas /app /data
ENV ATLAS_HOST=0.0.0.0
ENV ATLAS_PORT=4400
ENV ATLAS_STORE=memory
EXPOSE 4400
USER atlas
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4400/health >/dev/null || exit 1
CMD ["pnpm", "--filter", "@atlas/server", "exec", "tsx", "src/main.ts"]
