FROM node:24.22.1-alpine3.24 AS base

# Install dependencies only when needed
FROM base AS deps
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat jq
WORKDIR /app

# Copy root package files for workspace setup
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY .npmrc ./

# Copy all workspace package.json files
COPY packages/ ./packages/
COPY apps/ ./apps/

# Get PNPM version from package.json
# packageManager pins Corepack to the reviewed pnpm release.
# RUN export PNPM_VERSION=$(cat package.json | jq -r '.packageManager' | sed -E 's/pnpm@([0-9.]+)/\1/')
RUN corepack enable

# Build dependencies come from the reviewed lockfile.
RUN HUSKY=0 pnpm install --frozen-lockfile

# Build the app
FROM deps AS builder
WORKDIR /app

# Copy all source code
COPY . .

# Set build arguments and environment variables
ARG APP_NAME
ARG APP_LOG_LEVEL
ENV APP_LOG_LEVEL=${APP_LOG_LEVEL}
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_OUTPUT=standalone
ARG SALEOR_API_URL
ENV SALEOR_API_URL=${SALEOR_API_URL:-https://api.opensensor.wiki/graphql/}
ARG NEXT_PUBLIC_SALEOR_API_URL
ENV NEXT_PUBLIC_SALEOR_API_URL=${NEXT_PUBLIC_SALEOR_API_URL:-https://api.opensensor.wiki/graphql/}
ARG NEXT_PUBLIC_STOREFRONT_URL
ENV NEXT_PUBLIC_STOREFRONT_URL=${NEXT_PUBLIC_STOREFRONT_URL:-https://www.opensensor.wiki/}

# APL will be set at runtime via environment variables
# Default to file for build, but can be overridden at runtime
ARG APL
ENV APL=${APL:-file}

# Build validation uses inert placeholders; real credentials are runtime-only.
ENV SECRET_KEY=ci-build-placeholder-not-a-runtime-key
ENV FIEF_PLUGIN_HMAC_SECRET=ci-build-placeholder-not-a-runtime-key

# Build the specified app - map directory names to package names
RUN if [ "$APP_NAME" = "stripe" ]; then \
      pnpm --filter=saleor-app-payment-stripe build; \
    else \
      pnpm --filter=saleor-app-${APP_NAME} build; \
    fi

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
ARG APP_NAME
ENV SALEOR_APP_DIRECTORY=${APP_NAME}
ENV PORT=3010
ENV HOSTNAME=0.0.0.0
COPY --from=builder --chown=nextjs:nodejs /app/apps/${APP_NAME}/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/${APP_NAME}/.next/static ./apps/${APP_NAME}/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/${APP_NAME}/public ./apps/${APP_NAME}/public
RUN if [ "$APP_NAME" = "smtp" ]; then \
      node -e "const r=require('module').createRequire('/app/apps/smtp/package.json'); if(typeof r('@saleor/app-sdk/settings-manager').decrypt!=='function') process.exit(1); r('mongodb');"; \
    fi
USER nextjs
CMD ["sh", "-c", "exec node /app/apps/${SALEOR_APP_DIRECTORY}/server.js"]
