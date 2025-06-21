FROM node:22-alpine AS base

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
RUN export PNPM_VERSION=$(cat package.json | jq -r '.packageManager' | sed -E 's/pnpm@([0-9.]+)/\1/')
RUN corepack enable && corepack prepare pnpm@$PNPM_VERSION --activate

# Install ALL dependencies, including devDependencies (use --no-frozen-lockfile for CI)
RUN pnpm install --no-frozen-lockfile

# Build the app
FROM deps AS builder
WORKDIR /app

# Copy all source code
COPY . .

# Set build arguments and environment variables
ARG APP_NAME
ARG APP_LOG_LEVEL
ENV APP_LOG_LEVEL=${APP_LOG_LEVEL}
ARG REDIS_URL
ENV REDIS_URL=${REDIS_URL}
ARG SECRET_KEY
ENV SECRET_KEY=${SECRET_KEY}
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

# Install jq for getting PNPM version
RUN apk add --no-cache jq

# Copy package.json to get PNPM version
COPY package.json ./

# Get PNPM version from package.json and install
RUN export PNPM_VERSION=$(cat package.json | jq -r '.packageManager' | sed -E 's/pnpm@([0-9.]+)/\1/')
RUN corepack enable && corepack prepare pnpm@$PNPM_VERSION --activate

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Set APP_NAME for runtime
ARG APP_NAME
ENV APP_NAME=${APP_NAME}

# Copy workspace configuration
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=builder /app/.npmrc ./.npmrc

# Copy all packages (needed for workspace dependencies)
COPY --from=builder /app/packages ./packages

# Copy the specific app
COPY --from=builder /app/apps/${APP_NAME} ./apps/${APP_NAME}

# Copy the entire node_modules to ensure all dependencies are available
COPY --from=builder /app/node_modules ./node_modules

# Set the correct permission for prerender cache
RUN chown -R nextjs:nodejs apps/${APP_NAME}/.next

USER nextjs

WORKDIR /app/apps/${APP_NAME}

CMD ["sh", "-c", "PORT=3010 pnpm run start"]
