# ═══════════════════════════════════════════════
# Deft — Multi-stage Production Dockerfile
# ═══════════════════════════════════════════════

# Stage 1: Dependencies
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY packages/mcp/package.json packages/mcp/
RUN --mount=type=cache,id=deft-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --fetch-timeout 300000 install --frozen-lockfile

# Stage 2: Build
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
WORKDIR /app

# NEXT_PUBLIC_* values are compiled into the browser bundle by Next.js.
# docker-compose passes these as build args; declare and export them before
# `next build` so self-hosted installs on custom domains/ports do not silently
# fall back to localhost:3001.
ARG NEXT_PUBLIC_APP_URL=__DEFT_APP_URL__
ARG NEXT_PUBLIC_API_URL=__DEFT_API_URL__
ARG NEXT_PUBLIC_WS_URL=__DEFT_WS_URL__
ARG NEXT_PUBLIC_FEATURE_HUDDLES=false
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
ENV NEXT_PUBLIC_FEATURE_HUDDLES=$NEXT_PUBLIC_FEATURE_HUDDLES

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/mcp/node_modules ./packages/mcp/node_modules
# packages/shared has no external deps, so pnpm doesn't create a node_modules
# dir for it — nothing to copy.
COPY . .
RUN pnpm --filter @deft/web build

# Stage 3: Production
FROM node:22-alpine AS runner
# Runtime maintenance commands still use pnpm. Keep the runtime aligned with
# packageManager so Corepack never needs to download a different pnpm at boot.
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app

ENV NODE_ENV=production
ENV API_PORT=3001

# Copy built artifacts
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/web/.next ./apps/web/.next
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/apps/web/package.json ./apps/web/
COPY --from=builder /app/apps/web/next.config.ts ./apps/web/
# pnpm puts the apps/web-scoped binary symlinks (including .bin/next) here;
# without this, `pnpm exec next start` can't resolve the next CLI.
COPY --from=builder /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=builder /app/apps/api ./apps/api
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
COPY --from=builder /app/pnpm-lock.yaml ./

# Create uploads directory
RUN mkdir -p /app/uploads

EXPOSE 3000 3001

# Start both web and API. Use the locally-installed next binary (pnpm exec),
# not `npx next start` — npx downloads a fresh next install to ~/.npm/_npx/
# that lacks the Turbopack runtime files our build produced.
CMD ["sh", "/app/scripts/docker-entrypoint.sh"]
