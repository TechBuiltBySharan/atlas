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
ENV ATLAS_HOST=0.0.0.0
ENV ATLAS_PORT=4400
ENV ATLAS_STORE=memory
EXPOSE 4400
CMD ["pnpm", "--filter", "@atlas/server", "exec", "tsx", "src/main.ts"]
