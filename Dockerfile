FROM node:20-alpine AS base

# Install dependencies only when needed
FROM base AS deps
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat jq git
WORKDIR /app

# Copy necessary files for installation
COPY . .

WORKDIR /app/apps/smtp

# Get PNPM version from package.json
RUN npm i -g pnpm@9.11.0

# Install ALL dependencies, including devDependencies
RUN pnpm i

# Build the app
ARG APP_LOG_LEVEL
ENV APP_LOG_LEVEL=${APP_LOG_LEVEL}
ARG SECRET_KEY
ENV SECRET_KEY=${SECRET_KEY}
ARG REDIS_URL
ENV REDIS_URL=${REDIS_URL}
ARG SECRET_KEY
ENV SECRET_KEY=${SECRET_KEY}
ENV NEXT_TELEMETRY_DISABLED 1
ENV NEXT_OUTPUT=standalone
ARG SALEOR_API_URL
ENV SALEOR_API_URL=${SALEOR_API_URL:-https://api.opensensor.wiki/graphql/}
ARG NEXT_PUBLIC_SALEOR_API_URL
ENV NEXT_PUBLIC_SALEOR_API_URL=${NEXT_PUBLIC_SALEOR_API_URL:-https://api.opensensor.wiki/graphql/}
ARG NEXT_PUBLIC_STOREFRONT_URL
ENV NEXT_PUBLIC_STOREFRONT_URL=${NEXT_PUBLIC_STOREFRONT_URL:-https://www.opensensor.wiki/}

# Run the build script
RUN pnpm build

# Production image, copy all the files and run next
ENV NODE_ENV production
ENV NEXT_TELEMETRY_DISABLED 1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Set the correct permission for prerender cache
RUN chown -R nextjs:nodejs .next

USER nextjs

CMD PORT=3010 pnpm run start

