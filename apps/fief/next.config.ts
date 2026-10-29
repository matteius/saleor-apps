import { withSentryConfig } from "@sentry/nextjs";
import { type NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  transpilePackages: ["@saleor/apps-shared", "@saleor/apps-ui", "@saleor/react-hook-form-macaw"],
  experimental: {
    optimizePackageImports: ["@saleor/app-sdk"],
  },
  bundlePagesRouterDependencies: true,
  serverExternalPackages: ["mongodb"],
};

export default withSentryConfig(nextConfig, {
  org: "opensensor-engineering",
  project: "saleor-fief",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  release: { name: process.env.SENTRY_RELEASE },
  sourcemaps: { deleteSourcemapsAfterUpload: true },
});
